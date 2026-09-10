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

export type BuyerPaymentReceipt = {
  txHash: string
  buyerAddress: string
  amountWei: string
  batchId: string | null
  status: "verified" | "completed" | "failed"
  reportSummary: string | null
  createdAt: string
  updatedAt: string
}

export type RewardOptIn = {
  batchId: string
  walletAddress: string
  optedInAt: string
  status: "eligible" | "paid" | "excluded"
}

export type RewardAccounting = {
  batchId: string
  contributorCount: number
  walletCount: number
  rewardPoolWei: string
  perWalletWei: string | null
  status: "held" | "payable" | "paid"
  wallets: string[]
  allocations?: RewardAllocation[]
}

export type RewardAllocation = {
  batchId: string
  walletAddress: string
  amountWei: string
  status: "allocated" | "paid"
  transactionHash: string | null
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
    await supabaseRequest(
      `nugget_reward_opt_ins?id=not.is.null`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } },
    )
    return
  }
  await mkdir(dataDir, { recursive: true })
  await unlink(poolPath).catch(() => undefined)
  await unlink(path.join(dataDir, "receipts.json")).catch(() => undefined)
  await unlink(path.join(dataDir, "reward-opt-ins.json")).catch(() => undefined)
  const accountingFiles = await fs.promises.readdir(dataDir).catch(() => [])
  await Promise.all(
    accountingFiles
      .filter((name) => name.startsWith("reward-accounting-") && name.endsWith(".json"))
      .map((name) => unlink(path.join(dataDir, name)).catch(() => undefined)),
  )
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

export async function loadBuyerPayment(txHash: string): Promise<BuyerPaymentReceipt | null> {
  if (hostedStorageConfigured) {
    const rows = await supabaseRequest<BuyerPaymentReceipt[]>(
      `nugget_buyer_payments?select=txHash:tx_hash,buyerAddress:buyer_address,amountWei:amount_wei,batchId:batch_id,status,reportSummary:report_summary,createdAt:created_at,updatedAt:updated_at&tx_hash=eq.${encodeURIComponent(txHash)}&limit=1`,
    )
    return rows[0] ?? null
  }
  try {
    const raw = await readFile(path.join(dataDir, "buyer-payments.json"), "utf8")
    const payments = JSON.parse(raw) as BuyerPaymentReceipt[]
    return payments.find((payment) => payment.txHash.toLowerCase() === txHash.toLowerCase()) ?? null
  } catch {
    return null
  }
}

export async function saveBuyerPayment(payment: BuyerPaymentReceipt): Promise<void> {
  if (hostedStorageConfigured) {
    await supabaseRequest("nugget_buyer_payments", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        tx_hash: payment.txHash,
        buyer_address: payment.buyerAddress,
        amount_wei: payment.amountWei,
        batch_id: payment.batchId,
        status: payment.status,
        report_summary: payment.reportSummary,
        created_at: payment.createdAt,
        updated_at: payment.updatedAt,
      }),
    })
    return
  }

  await withPoolLock(async () => {
    await mkdir(dataDir, { recursive: true })
    let payments: BuyerPaymentReceipt[] = []
    try {
      payments = JSON.parse(await readFile(path.join(dataDir, "buyer-payments.json"), "utf8"))
    } catch {
      payments = []
    }
    const next = [
      payment,
      ...payments.filter((entry) => entry.txHash.toLowerCase() !== payment.txHash.toLowerCase()),
    ]
    await writeFile(path.join(dataDir, "buyer-payments.json"), JSON.stringify(next, null, 2), "utf8")
  })
}

export async function saveRewardOptIn(optIn: RewardOptIn): Promise<void> {
  if (hostedStorageConfigured) {
    await supabaseRequest("nugget_reward_opt_ins?on_conflict=batch_id,wallet_address", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        batch_id: optIn.batchId,
        wallet_address: optIn.walletAddress,
        opted_in_at: optIn.optedInAt,
        status: optIn.status,
      }),
    })
    return
  }

  await withPoolLock(async () => {
    await mkdir(dataDir, { recursive: true })
    let optIns: RewardOptIn[] = []
    try {
      optIns = JSON.parse(await readFile(path.join(dataDir, "reward-opt-ins.json"), "utf8"))
    } catch {
      optIns = []
    }

    const exists = optIns.some(
      (entry) =>
        entry.batchId === optIn.batchId &&
        entry.walletAddress.toLowerCase() === optIn.walletAddress.toLowerCase(),
    )
    if (!exists) {
      await writeFile(
        path.join(dataDir, "reward-opt-ins.json"),
        JSON.stringify([optIn, ...optIns], null, 2),
        "utf8",
      )
    }
  })
}

export async function loadEncryptedBatch(): Promise<EncryptedContributionBatch | null> {
  const pool = await loadEncryptedPool()
  if (!pool || pool.contributions.length === 0) return null
  return pool
}

export async function loadRewardAllocations(batchId: string): Promise<RewardAllocation[]> {
  if (hostedStorageConfigured) {
    return supabaseRequest<RewardAllocation[]>(
      `nugget_reward_allocations?select=batchId:batch_id,walletAddress:wallet_address,amountWei:amount_wei,status,transactionHash:transaction_hash&batch_id=eq.${encodeURIComponent(batchId)}&order=wallet_address.asc`,
    )
  }
  try {
    return JSON.parse(
      await readFile(path.join(dataDir, `reward-accounting-${batchId}.json`), "utf8"),
    ).allocations as RewardAllocation[]
  } catch {
    return []
  }
}

export async function markRewardAllocationPaid(
  allocation: RewardAllocation,
  transactionHash: string,
): Promise<void> {
  if (hostedStorageConfigured) {
    await supabaseRequest(
      `nugget_reward_allocations?batch_id=eq.${encodeURIComponent(allocation.batchId)}&wallet_address=eq.${encodeURIComponent(allocation.walletAddress)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "paid", transaction_hash: transactionHash }),
      },
    )
    return
  }
  const pathName = path.join(dataDir, `reward-accounting-${allocation.batchId}.json`)
  await withPoolLock(async () => {
    const accounting = JSON.parse(await readFile(pathName, "utf8")) as RewardAccounting & {
      allocations?: RewardAllocation[]
    }
    accounting.allocations = (accounting.allocations ?? []).map((entry) =>
      entry.walletAddress.toLowerCase() === allocation.walletAddress.toLowerCase()
        ? { ...entry, status: "paid" as const, transactionHash }
        : entry,
    )
    await writeFile(pathName, JSON.stringify(accounting, null, 2), "utf8")
  })
}

export async function accountRewards(
  batchId: string,
  contributorCount: number,
  rewardPoolWei: string,
): Promise<RewardAccounting> {
  const payoutKMin = Number(process.env.PAYOUT_K_MIN || "2")
  if (!Number.isSafeInteger(payoutKMin) || payoutKMin < 2) {
    throw new Error("PAYOUT_K_MIN must be an integer of at least 2")
  }

  let wallets: string[]
  if (hostedStorageConfigured) {
    const rows = await supabaseRequest<Array<{ wallet_address: string }>>(
      `nugget_reward_opt_ins?select=wallet_address&batch_id=eq.${encodeURIComponent(batchId)}&status=eq.eligible`,
    )
    wallets = [...new Set(rows.map((row) => row.wallet_address.toLowerCase()))]
  } else {
    try {
      const raw = await readFile(path.join(dataDir, "reward-opt-ins.json"), "utf8")
      const entries = JSON.parse(raw) as RewardOptIn[]
      wallets = [...new Set(
        entries
          .filter((entry) => entry.batchId === batchId && entry.status === "eligible")
          .map((entry) => entry.walletAddress.toLowerCase()),
      )]
    } catch {
      wallets = []
    }
  }
  const payable = contributorCount >= payoutKMin && wallets.length >= payoutKMin
  const perWalletWei = payable ? (BigInt(rewardPoolWei) / BigInt(wallets.length)).toString() : null
  const accounting: RewardAccounting = {
    batchId,
    contributorCount,
    walletCount: wallets.length,
    rewardPoolWei,
    perWalletWei,
    status: payable ? "payable" : "held",
    wallets,
    allocations: payable
      ? wallets.map((walletAddress) => ({
          batchId,
          walletAddress,
          amountWei: perWalletWei!,
          status: "allocated" as const,
          transactionHash: null,
        }))
      : [],
  }
  if (hostedStorageConfigured) {
    await supabaseRequest("nugget_reward_batches?on_conflict=batch_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        batch_id: batchId,
        contributor_count: contributorCount,
        wallet_count: wallets.length,
        reward_pool_wei: rewardPoolWei,
        per_wallet_wei: perWalletWei,
        status: accounting.status,
        updated_at: new Date().toISOString(),
      }),
    })
    if (payable) {
      await supabaseRequest("nugget_reward_allocations", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(wallets.map((walletAddress) => ({
          batch_id: batchId,
          wallet_address: walletAddress,
          amount_wei: perWalletWei,
          status: "allocated",
        }))),
      })
    }
  } else {
    await withPoolLock(async () => {
      await mkdir(dataDir, { recursive: true })
      await writeFile(
        path.join(dataDir, `reward-accounting-${batchId}.json`),
        JSON.stringify(accounting, null, 2),
        "utf8",
      )
    })
  }

  return accounting
}

export async function markRewardBatchPaid(batchId: string): Promise<void> {
  if (hostedStorageConfigured) {
    await supabaseRequest(
      `nugget_reward_batches?batch_id=eq.${encodeURIComponent(batchId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "paid", updated_at: new Date().toISOString() }),
      },
    )
  }
}
