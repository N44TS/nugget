import { mkdir, readFile, writeFile, rename, unlink } from "fs/promises"
import fs from "fs"
import path from "path"
import type { CreEncryptedContribution } from "./crypto"
import type { EncryptedContributionBatch } from "./types"

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
    if (fs.existsSync(path.join(dir, "encrypted-pool.json"))) return dir
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
const poolPath = path.join(dataDir, "encrypted-pool.json")
const lockPath = path.join(dataDir, "pool.lock")

const hostedStorageConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const supabaseRequest = async <T>(
  table: string,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`Supabase ${table} request failed with status ${response.status}`)
  }
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export type ContributionReceipt = {
  claimId: string
  batchId: string
  createdAt: string
  inEncryptedPool: boolean
}

export function poolDataDir(): string {
  return hostedStorageConfigured ? "supabase:nugget_contributions" : dataDir
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

export async function loadEncryptedPool(): Promise<EncryptedContributionBatch | null> {
  if (hostedStorageConfigured) {
    const latest = await supabaseRequest<Array<{ epoch: string }>>(
      "nugget_contributions?select=epoch&order=created_at.desc&limit=1",
    )
    if (latest.length === 0) return null
    const epoch = latest[0]!.epoch
    const rows = await supabaseRequest<Array<{ envelope: CreEncryptedContribution; epoch: string }>>(
      `nugget_contributions?select=epoch,envelope&epoch=eq.${encodeURIComponent(epoch)}&order=created_at.asc`,
    )
    if (rows.length === 0) return null
    return {
      encoding: "nugget1-contribution-batch-v1",
      epoch,
      contributions: rows.map((row) => row.envelope),
    }
  }
  try {
    const raw = await readFile(poolPath, "utf8")
    const parsed = JSON.parse(raw) as EncryptedContributionBatch
    if (
      parsed?.encoding !== "nugget1-contribution-batch-v1" ||
      !parsed.epoch ||
      !Array.isArray(parsed.contributions)
    ) return null
    return parsed
  } catch {
    return null
  }
}

async function writePoolAtomic(batch: EncryptedContributionBatch): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const tmp = `${poolPath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(batch, null, 2), "utf8")
  await rename(tmp, poolPath)
}

/** Append (or replace same claimId) one real contribution. Never drops other rows. */
export async function addEncryptedContribution(
  contribution: CreEncryptedContribution,
  batchId: string,
): Promise<EncryptedContributionBatch> {
  if (hostedStorageConfigured) {
    await supabaseRequest("nugget_contributions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ epoch: batchId, envelope: contribution }),
    })
    return (await loadEncryptedPool())!
  }
  return withPoolLock(async () => {
    const prior = (await loadEncryptedPool()) ?? {
      encoding: "nugget1-contribution-batch-v1" as const,
      epoch: batchId,
      contributions: [],
    }
    const next: EncryptedContributionBatch = {
      encoding: "nugget1-contribution-batch-v1",
      epoch: batchId,
      contributions: [...prior.contributions, contribution],
    }
    await writePoolAtomic(next)
    return next
  })
}

export async function clearPool(): Promise<void> {
  if (hostedStorageConfigured) {
    await supabaseRequest(
      `nugget_contributions?epoch=not.is.null`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } },
    )
    await supabaseRequest(
      `nugget_receipts?id=not.is.null`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } },
    )
    return
  }
  await mkdir(dataDir, { recursive: true })
  await unlink(poolPath).catch(() => undefined)
  await unlink(path.join(dataDir, "receipts.json")).catch(() => undefined)
  // legacy encrypted file from older builds
  await unlink(path.join(dataDir, "contributions.encrypted.json")).catch(() => undefined)
}

export async function loadReceipts(): Promise<ContributionReceipt[]> {
  if (hostedStorageConfigured) {
    return supabaseRequest<ContributionReceipt[]>(
      "nugget_receipts?select=claimId:claim_id,batchId:batch_id,createdAt:created_at,inEncryptedPool:in_encrypted_pool&order=created_at.desc",
    )
  }
  try {
    const raw = await readFile(path.join(dataDir, "receipts.json"), "utf8")
    const parsed = JSON.parse(raw) as ContributionReceipt[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveReceipt(receipt: ContributionReceipt): Promise<void> {
  if (hostedStorageConfigured) {
    await supabaseRequest("nugget_receipts", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        claim_id: receipt.claimId,
        batch_id: receipt.batchId,
        created_at: receipt.createdAt,
        in_encrypted_pool: receipt.inEncryptedPool,
      }),
    })
    return
  }
  await withPoolLock(async () => {
    const existing = await loadReceipts()
    const next = [receipt, ...existing.filter((r) => r.claimId !== receipt.claimId)]
    await writeFile(path.join(dataDir, "receipts.json"), JSON.stringify(next, null, 2), "utf8")
  })
}

export async function loadEncryptedBatch(): Promise<EncryptedContributionBatch | null> {
  const pool = await loadEncryptedPool()
  if (!pool || pool.contributions.length === 0) return null
  return pool
}
