import { mkdir, readFile, writeFile, rename, unlink } from "fs/promises"
import fs from "fs"
import path from "path"
import { wrapEncryptedBatch } from "./crypto"
import type { Contribution, ContributionBatch, EncryptedWrapper } from "./types"

/**
 * Resolve ONE shared pool directory no matter which port / cwd Next uses.
 */
export function resolveDataDir(): string {
  if (process.env.NUGGET_DATA_DIR) return path.resolve(process.env.NUGGET_DATA_DIR)

  const cwd = process.cwd()
  const candidates = [
    // next app lives in web/
    path.resolve(cwd, ".nugget-data"),
    path.resolve(cwd, "..", ".nugget-data"),
    // started from repo root
    path.resolve(cwd, "web", "..", ".nugget-data"),
  ]

  // Prefer an existing dir that already has pool data, else prefer repo marker
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "pool.json"))) return dir
  }
  for (const dir of candidates) {
    const parent = path.dirname(dir)
    if (fs.existsSync(path.join(parent, "cre-hello-confidential"))) return dir
  }
  // Default: sibling of web/ when cwd is web
  if (path.basename(cwd) === "web") return path.resolve(cwd, "..", ".nugget-data")
  return path.resolve(cwd, ".nugget-data")
}

const dataDir = resolveDataDir()
const poolPath = path.join(dataDir, "pool.json")
const lockPath = path.join(dataDir, "pool.lock")

export type ContributionReceipt = {
  claimId: string
  batchId: string
  createdAt: string
  inEncryptedPool: boolean
}

export function poolDataDir(): string {
  return dataDir
}

export function contributionSecret(): string {
  return process.env.CONTRIBUTION_SECRET || process.env.SECRET_API_TOKEN || "nugget-phase0-sim-token"
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

/** Simple exclusive lock so :3000 and :3001 cannot overwrite each other. */
async function withPoolLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dataDir, { recursive: true })
  const started = Date.now()
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx")
      fs.closeSync(fd)
      break
    } catch {
      if (Date.now() - started > 10000) throw new Error("timeout waiting for pool lock")
      // stale lock > 30s
      try {
        const st = fs.statSync(lockPath)
        if (Date.now() - st.mtimeMs > 30000) fs.unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
      await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => undefined)
  }
}

export async function loadPool(): Promise<ContributionBatch | null> {
  try {
    const raw = await readFile(poolPath, "utf8")
    const parsed = JSON.parse(raw) as ContributionBatch
    if (!parsed?.epoch || !Array.isArray(parsed.contributions)) return null
    return parsed
  } catch {
    return null
  }
}

async function writePoolAtomic(batch: ContributionBatch): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const tmp = `${poolPath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(batch, null, 2), "utf8")
  await rename(tmp, poolPath)
}

/** Append (or replace same claimId) one real contribution. Never drops other rows. */
export async function addContribution(
  contribution: Contribution,
  batchId: string,
): Promise<ContributionBatch> {
  return withPoolLock(async () => {
    const prior = (await loadPool()) ?? { epoch: batchId, contributions: [] }
    const others = prior.contributions.filter((c) => c.claimId !== contribution.claimId)
    const next: ContributionBatch = {
      epoch: batchId,
      contributions: [...others, contribution],
    }
    await writePoolAtomic(next)
    return next
  })
}

export async function clearPool(): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await unlink(poolPath).catch(() => undefined)
  await unlink(path.join(dataDir, "receipts.json")).catch(() => undefined)
  // legacy encrypted file from older builds
  await unlink(path.join(dataDir, "contributions.encrypted.json")).catch(() => undefined)
}

export async function loadReceipts(): Promise<ContributionReceipt[]> {
  try {
    const raw = await readFile(path.join(dataDir, "receipts.json"), "utf8")
    const parsed = JSON.parse(raw) as ContributionReceipt[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveReceipt(receipt: ContributionReceipt): Promise<void> {
  await withPoolLock(async () => {
    const existing = await loadReceipts()
    const next = [receipt, ...existing.filter((r) => r.claimId !== receipt.claimId)]
    await writeFile(path.join(dataDir, "receipts.json"), JSON.stringify(next, null, 2), "utf8")
  })
}

/** Encrypt current pool for CRE HTTP fetch (built on the fly from pool.json). */
export function encryptPoolForCre(batch: ContributionBatch): EncryptedWrapper {
  return wrapEncryptedBatch(JSON.stringify(batch), contributionSecret())
}

export async function loadEncryptedBatch(): Promise<EncryptedWrapper | null> {
  const pool = await loadPool()
  if (!pool || pool.contributions.length === 0) return null
  return encryptPoolForCre(pool)
}

/** @deprecated use loadPool — kept name for older imports */
export async function decryptStoredBatch(): Promise<ContributionBatch | null> {
  return loadPool()
}
