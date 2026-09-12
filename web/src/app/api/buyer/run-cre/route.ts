import { NextResponse } from "next/server"
import { spawn } from "child_process"
import { existsSync } from "fs"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import {
  loadBuyerPayment,
  loadEncryptedPool,
  poolDataDir,
  saveBuyerPayment,
  accountRewards,
  saveRewardClaimProofs,
} from "@/lib/server-batch"
import { payRewards, settleEscrowBatch } from "@/lib/treasury"
import { decodeFunctionData } from "viem"
import { batchCommitment, escrowAddress, nuggetBatchEscrowAbi, purchaseBatchId } from "@/lib/escrow"
import { payoutWindowId } from "@/lib/cycle"
import { aggregateContributions, formatPublicSummary, isValidContribution } from "@/lib/aggregate"
import { base64ToBytes, type CreEncryptedContribution } from "@/lib/crypto"
import { buildRewardTree, rewardProof } from "@/lib/escrow"
import { x25519 } from "@noble/curves/ed25519.js"
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { sha256 } from "@noble/hashes/sha2.js"

export const maxDuration = 120
const K_MIN = 2
let isRunning = false
const SEPOLIA_CHAIN_ID = "0xaa36a7"
type CreRun = { ok: boolean; summary: string | null; log: string; error?: string }

async function verifyPayment(txHash: string, expectedBatchId?: string) {
  const treasury = (
    process.env.BUYER_PAYMENT_TREASURY ||
    process.env.NEXT_PUBLIC_BUYER_PAYMENT_TREASURY
  )?.toLowerCase()
  const escrow = escrowAddress()
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
  const requiredWei =
    process.env.BUYER_PAYMENT_WEI ||
    process.env.NEXT_PUBLIC_BUYER_PAYMENT_WEI ||
    "1000000000000000"
  const paymentDestination = escrow?.toLowerCase() ?? treasury
  if (!paymentDestination || !rpcUrl || !requiredWei) {
    console.error("[buyer] payment configuration incomplete", {
      treasury: Boolean(treasury),
      rpcUrl: Boolean(rpcUrl),
      requiredWei: Boolean(requiredWei),
      serverTreasury: Boolean(process.env.BUYER_PAYMENT_TREASURY),
      publicTreasury: Boolean(process.env.NEXT_PUBLIC_BUYER_PAYMENT_TREASURY),
      serverAmount: Boolean(process.env.BUYER_PAYMENT_WEI),
      publicAmount: Boolean(process.env.NEXT_PUBLIC_BUYER_PAYMENT_WEI),
    })
    throw new Error("Buyer payment configuration is incomplete")
  }
  console.log("[buyer] payment configuration loaded", {
    treasury: paymentDestination,
    rpcSource: process.env.SEPOLIA_RPC_URL ? "SEPOLIA_RPC_URL" : "publicnode-default",
    requiredWei,
  })
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("Invalid payment transaction hash")
  }

  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    })
    if (!response.ok) throw new Error(`Sepolia RPC returned ${response.status}`)
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
    if (body.error) throw new Error(body.error.message || "Sepolia RPC error")
    return body.result
  }

  const transaction = (await rpc("eth_getTransactionByHash", [txHash])) as {
    from?: string
    to?: string
    value?: string
    chainId?: string
  } | null
  if (!transaction) throw new Error("Payment transaction was not found yet")
  if (transaction.chainId?.toLowerCase() !== SEPOLIA_CHAIN_ID) {
    throw new Error("Payment must be made on Ethereum Sepolia")
  }
  if (transaction.to?.toLowerCase() !== paymentDestination) {
    throw new Error("Payment recipient does not match the configured treasury")
  }
  if (escrow) {
    try {
      const decoded = decodeFunctionData({ abi: nuggetBatchEscrowAbi, data: (transaction as { input?: `0x${string}` }).input ?? "0x" })
      const fundedBatch = decoded.functionName === "fundBatch" ? decoded.args[0] : null
      if (!expectedBatchId || fundedBatch !== batchCommitment(expectedBatchId)) {
        throw new Error("Escrow payment funds a different batch")
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message === "Escrow payment funds a different batch") throw cause
      throw new Error("Escrow payment must call fundBatch for the current batch")
    }
  }
  if (BigInt(transaction.value || "0x0") < BigInt(requiredWei)) {
    throw new Error("Payment amount is below the required report fee")
  }

  const receipt = (await rpc("eth_getTransactionReceipt", [txHash])) as {
    status?: string
    blockNumber?: string
  } | null
  if (!receipt?.blockNumber) throw new Error("Payment is not confirmed yet")
  if (receipt.status !== "0x1") throw new Error("Payment transaction failed")
  return {
    buyerAddress: transaction.from || "unknown",
    amountWei: BigInt(transaction.value || "0x0").toString(),
  }
}

async function runCreSimulate(poolFetchUrl: string, rewardWindowId: string) {
  const creBin = process.env.CRE_BIN || path.join(process.env.HOME || "", ".cre/bin/cre")
  const configuredRoot = process.env.CRE_PROJECT_ROOT
  const projectRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.resolve(process.cwd(), "../cre-hello-confidential")
  const altRoot = path.resolve(process.cwd(), "cre-hello-confidential")
  const root = existsSync(path.join(projectRoot, "my-workflow")) ? projectRoot : altRoot
  if (!existsSync(path.join(root, "my-workflow"))) {
    throw new Error("CRE project is not available in this deployment")
  }
  if (!process.env.CRE_ENCRYPTION_PRIVATE_KEY) {
    throw new Error("CRE_ENCRYPTION_PRIVATE_KEY is not configured")
  }
  const configPath = path.join(root, "my-workflow", "config.staging.json")
  const bunBin = path.join(process.env.HOME || "", ".bun/bin")
  const creDir = path.dirname(creBin)

  const previous = await readFile(configPath, "utf8")
  const config = JSON.parse(previous) as Record<string, unknown>
  config.url = poolFetchUrl
  config.kMin = K_MIN
  config.rewardWindowId = rewardWindowId
  config.emitClaimProofs = true
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6)
  config.reportSince = sixMonthsAgo.toISOString()
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  console.log("[cre] prepared simulation", {
    workflow: "my-workflow",
    target: "staging-settings",
    kMin: K_MIN,
    endpoint: poolFetchUrl,
  })

  try {
    return await new Promise<{ ok: boolean; summary: string | null; log: string; error?: string }>(
      (resolve) => {
        const args = [
          "workflow",
          "simulate",
          "my-workflow",
          "--target",
          "staging-settings",
          "--non-interactive",
          "--trigger-index",
          "0",
        ]
        console.log("[cre] spawning", { command: creBin, args, cwd: root, poolFetchUrl })
        const child = spawn(
          creBin,
          args,
          {
            cwd: root,
            env: { ...process.env, PATH: `${creDir}:${bunBin}:${process.env.PATH || ""}` },
          },
        )
        let out = ""
        const logChunk = (prefix: string, chunk: string, write: (message: string) => void) => {
          const safeChunk = chunk
            .split(/(?<=\n)/)
            .filter((line) => !line.includes("NUGGET_CLAIM_PROOFS="))
            .join("")
          if (safeChunk.trim()) write(`${prefix} ${safeChunk.trimEnd()}`)
        }
        child.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString()
          out += chunk
          logChunk("[cre stdout]", chunk, console.log)
        })
        child.stderr.on("data", (d: Buffer) => {
          const chunk = d.toString()
          out += chunk
          logChunk("[cre stderr]", chunk, console.error)
        })
        const timeout = setTimeout(() => {
          console.error("[cre] simulation timed out")
          child.kill("SIGTERM")
          resolve({ ok: false, summary: null, log: out, error: "CRE simulation timed out" })
        }, 110_000)
        child.on("error", (err) => {
          clearTimeout(timeout)
          console.error("[cre] spawn error", err)
          resolve({ ok: false, summary: null, log: out, error: err.message })
        })
        child.on("close", (code) => {
          clearTimeout(timeout)
          console.log("[cre] process closed", { code })
          const match = out.match(/Workflow Simulation Result:\s*\n?"([^"]+)"/)
          console.log("[cre] simulation result", {
            exitCode: code,
            hasSummary: Boolean(match?.[1]),
          })
          resolve({
            ok: code === 0 && Boolean(match?.[1]),
            summary: match?.[1] ?? null,
            // Keep the TEE-produced claim package intact; it is required to
            // claim the exact root that was settled on-chain.
            log: out.slice(-200_000),
            error: code === 0 ? undefined : `cre exited ${code}`,
          })
        })
      },
    )
  } finally {
    await writeFile(configPath, previous, "utf8")
  }
}

/**
 * Deliberately opt-in fallback for the hackathon when the CRE CLI account is
 * unavailable. It executes the same ciphertext → decrypt → validate →
 * k-anonymous aggregate → Merkle-root pipeline locally. It is not a TEE and
 * must never be described as one or used for production-sensitive data.
 */
async function runLocalCreSimulation(
  pool: NonNullable<Awaited<ReturnType<typeof loadEncryptedPool>>>,
  rewardWindowId: string,
): Promise<CreRun> {
  const privateKeyB64 = process.env.CRE_ENCRYPTION_PRIVATE_KEY
  if (!privateKeyB64) return { ok: false, summary: null, log: "", error: "CRE_ENCRYPTION_PRIVATE_KEY is not configured" }
  try {
    console.log("[cre local] starting encrypted contribution simulation", {
      contributionCount: pool.contributions.length,
      kMin: K_MIN,
    })
    const privateKey = base64ToBytes(privateKeyB64)
    if (privateKey.length !== 32) throw new Error("CRE_ENCRYPTION_PRIVATE_KEY must decode to 32 bytes")
    const decrypt = (envelope: CreEncryptedContribution): unknown => {
      const sharedSecret = x25519.getSharedSecret(privateKey, base64ToBytes(envelope.ephemeralPublicKey))
      const plaintext = xchacha20poly1305(sha256(sharedSecret), base64ToBytes(envelope.nonce)).decrypt(base64ToBytes(envelope.payload))
      return JSON.parse(new TextDecoder().decode(plaintext))
    }
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6)
    const contributions = pool.contributions.map(decrypt) as Parameters<typeof aggregateContributions>[0]["contributions"]
    const reportContributions = contributions.filter(
      (contribution) => !contribution.submittedAt || contribution.submittedAt >= sixMonthsAgo.toISOString(),
    )
    console.log("[cre local] decrypted and filtered contributions", {
      count: reportContributions.length,
    })
    const report = aggregateContributions({ epoch: pool.epoch, contributions: reportContributions }, K_MIN)
    const eligibleClaims = new Set(
      reportContributions
        .filter((contribution) =>
          isValidContribution(contribution) &&
          contribution.payoutWindowId === rewardWindowId &&
          (!contribution.submittedAt || contribution.submittedAt >= sixMonthsAgo.toISOString()),
        )
        .map((contribution) => contribution.claimId),
    )
    const wallets = (pool.rewardRegistrations ?? [])
      .map(decrypt)
      .filter((value): value is { claimId: string; walletAddress: string } =>
        Boolean(value) && typeof value === "object" &&
        typeof (value as { claimId?: unknown }).claimId === "string" &&
        typeof (value as { walletAddress?: unknown }).walletAddress === "string",
      )
      .filter((registration) => eligibleClaims.has(registration.claimId) && /^0x[a-fA-F0-9]{40}$/.test(registration.walletAddress))
      .map((registration) => registration.walletAddress)
    const uniqueWallets = [...new Set(wallets.map((wallet) => wallet.toLowerCase()))]
    const tree = uniqueWallets.length ? buildRewardTree(uniqueWallets) : null
    const proofs = Object.fromEntries(uniqueWallets.map((wallet) => [wallet, rewardProof(uniqueWallets, wallet)]))
    const summary = `${formatPublicSummary(report)} rewardRoot=${tree?.root ?? "none"} eligibleWallets=${uniqueWallets.length}`
    console.log("[cre local] aggregation complete", {
      validCount: report.validCount,
      rejectedCount: report.rejectedCount,
      eligibleWallets: uniqueWallets.length,
      hasRewardRoot: Boolean(tree?.root),
    })
    return { ok: true, summary, log: `NUGGET_CLAIM_PROOFS=${JSON.stringify(proofs)}` }
  } catch (cause) {
    console.error("[cre local] simulation failed", cause)
    return { ok: false, summary: null, log: "", error: cause instanceof Error ? cause.message : "Local CRE simulation failed" }
  }
}

async function runConfiguredCreSimulation(
  pool: NonNullable<Awaited<ReturnType<typeof loadEncryptedPool>>>,
  poolFetchUrl: string,
  rewardWindowId: string,
): Promise<CreRun> {
  if (process.env.NUGGET_LOCAL_CRE_SIMULATION === "true") {
    console.warn("[cre] using local simulation fallback — this is not a Chainlink TEE")
    return runLocalCreSimulation(pool, rewardWindowId)
  }
  return runCreSimulate(poolFetchUrl, rewardWindowId)
}

export async function POST(request: Request) {
  if (isRunning) {
    return NextResponse.json(
      { ok: false, error: "Another aggregation is already running — please try again in a few seconds." },
      { status: 429 },
    )
  }
  isRunning = true

  try {
    const body = (await request.json().catch(() => ({}))) as {
      paymentTxHash?: string
      payoutWindowId?: string
      purchaseId?: string
    }
    if (!body.paymentTxHash) {
      return NextResponse.json({ ok: false, error: "A confirmed buyer payment is required" }, { status: 402 })
    }
    const pool = await loadEncryptedPool()
    if (!pool || pool.contributions.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Pool empty. Opt in on :3000 and/or :3001 first.",
          dataDir: poolDataDir(),
        },
        { status: 400 },
      )
    }
    try {
      const existing = await loadBuyerPayment(body.paymentTxHash)
      if (existing?.status === "completed" && existing.reportSummary) {
        return NextResponse.json({
          ok: true,
          source: "stored-buyer-report",
          creSummary: existing.reportSummary,
          payment: {
            txHash: existing.txHash,
            status: existing.status,
            explorerUrl: `https://sepolia.etherscan.io/tx/${existing.txHash}`,
          },
          note: "This payment already unlocked this report; the stored result was returned.",
        })
      }
      const currentPayoutWindow = payoutWindowId()
      if (body.payoutWindowId !== currentPayoutWindow || !body.purchaseId?.startsWith(`${currentPayoutWindow}:`)) {
        throw new Error("This purchase was prepared for a different payout window")
      }
      const verified = await verifyPayment(body.paymentTxHash, body.purchaseId)
      const now = new Date().toISOString()
      await saveBuyerPayment({
        txHash: body.paymentTxHash,
        buyerAddress: verified.buyerAddress,
        amountWei: verified.amountWei,
        batchId: body.purchaseId,
        status: "verified",
        reportSummary: null,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment verification failed"
      console.error("[buyer] payment verification failed", {
        error: message,
        transaction: body.paymentTxHash,
      })
      return NextResponse.json({ ok: false, error: message }, { status: 402 })
    }
    console.log("[buyer] payment verified", { transaction: body.paymentTxHash })
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host")
    const proto = request.headers.get("x-forwarded-proto") || "https"
    if (!host) {
      return NextResponse.json({ ok: false, error: "Public request host unavailable" }, { status: 500 })
    }
    const poolFetchUrl = `${proto}://${host}/api/contributions/encrypted`
    console.log("[cre] aggregation requested", {
      poolSize: pool.contributions.length,
      endpoint: poolFetchUrl,
      storage: poolDataDir(),
    })

    const rewardWindowId = body.payoutWindowId || payoutWindowId()
    const purchaseId = body.purchaseId || purchaseBatchId(rewardWindowId, body.paymentTxHash)
    let cre: CreRun
    try {
      cre = await runConfiguredCreSimulation(pool, poolFetchUrl, rewardWindowId)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown CRE runner error"
      console.error("[cre] runner setup error", error)
      return NextResponse.json(
        {
          ok: false,
          error: message,
          poolFetchUrl,
          dataDir: poolDataDir(),
          poolSizeBeforeCre: pool.contributions.length,
        },
        { status: 500 },
      )
    }
    if (!cre.ok || !cre.summary) {
      console.error("[cre] aggregation failed", {
        error: cre.error || "CRE simulate failed",
        poolSize: pool.contributions.length,
      })
      return NextResponse.json(
        {
          ok: false,
          error: cre.error || "CRE simulate failed",
          creLogTail: cre.log,
          poolFetchUrl,
          dataDir: poolDataDir(),
          poolSizeBeforeCre: pool.contributions.length,
        },
        { status: 500 },
      )
    }

    const completedAt = new Date().toISOString()
    const existingPayment = await loadBuyerPayment(body.paymentTxHash)
    if (existingPayment) {
      await saveBuyerPayment({
        ...existingPayment,
        batchId: purchaseId,
        status: "completed",
        reportSummary: cre.summary,
        updatedAt: completedAt,
      })
    }
    const rewardMatch = cre.summary.match(/rewardRoot=(0x[a-fA-F0-9]{64})\s+eligibleWallets=(\d+)/)
    const creRewardRoot = rewardMatch?.[1] as `0x${string}` | undefined
    const creEligibleWalletCount = rewardMatch ? Number(rewardMatch[2]) : 0
    const proofMatch = cre.log.match(/NUGGET_CLAIM_PROOFS=(\{[^\n\r]*\})/)
    let teeProofs: Record<string, `0x${string}`[]> = {}
    if (proofMatch?.[1]) {
      try {
        teeProofs = JSON.parse(proofMatch[1]) as Record<string, `0x${string}`[]>
      } catch {
        console.warn("[cre] claim proof package could not be parsed")
      }
    }
    if (creRewardRoot && Object.keys(teeProofs).length === creEligibleWalletCount) {
      await saveRewardClaimProofs(purchaseId, teeProofs)
    }
    const rewardAccounting = existingPayment && !escrowAddress()
      ? await accountRewards(purchaseId, pool.contributions.length, existingPayment.amountWei, rewardWindowId)
      : null
    let payout: Awaited<ReturnType<typeof payRewards>> | null = null
    let escrowSettlement: { txHash: string } | null = null
    const escrowPayable = Boolean(
      escrowAddress() &&
      creRewardRoot &&
      creEligibleWalletCount >= K_MIN &&
      pool.contributions.length >= K_MIN,
    )
    if (escrowPayable || rewardAccounting?.status === "payable") {
      if (escrowPayable) {
        try {
          if (!creRewardRoot || creEligibleWalletCount === 0) {
            throw new Error("CRE found no eligible reward wallets for this batch")
          }
          escrowSettlement = await settleEscrowBatch(purchaseId, creRewardRoot, creEligibleWalletCount)
        } catch (error) {
          console.error("[escrow] settlement failed", { batchId: pool.epoch, error })
          payout = {
            status: "held",
            batchId: rewardWindowId,
            payouts: [],
            error: error instanceof Error ? error.message : "Escrow settlement failed",
          }
        }
      } else {
        try {
          payout = await payRewards(purchaseId)
        } catch (error) {
          console.error("[rewards] settlement failed", { batchId: pool.epoch, error })
          payout = {
            status: "held",
            batchId: rewardWindowId,
            payouts: [],
            error: error instanceof Error ? error.message : "Reward settlement failed",
          }
        }
      }
    }

    console.log("[cre] aggregation complete", {
      poolSize: pool.contributions.length,
      summary: cre.summary,
    })
    return NextResponse.json({
      ok: true,
      source: process.env.NUGGET_LOCAL_CRE_SIMULATION === "true" ? "local-cre-simulation" : "cre-workflow-simulate",
      poolFetchUrl,
      dataDir: poolDataDir(),
      poolSize: pool.contributions.length,
      creSummary: cre.summary,
      payment: {
        txHash: body.paymentTxHash,
        status: "completed",
        explorerUrl: `https://sepolia.etherscan.io/tx/${body.paymentTxHash}`,
      },
      rewardAccounting: rewardAccounting && {
        batchId: rewardAccounting.batchId,
        contributorCount: rewardAccounting.contributorCount,
        walletCount: rewardAccounting.walletCount,
        rewardPoolWei: rewardAccounting.rewardPoolWei,
        perWalletWei: rewardAccounting.perWalletWei,
        status: rewardAccounting.status,
      },
      payout: payout && {
        status: payout.status,
        payouts: payout.payouts.map(({ amountWei, transactionHash }) => ({
          amountWei,
          transactionHash,
        })),
        error: payout.error,
      },
      escrowSettlement: escrowSettlement && {
        txHash: escrowSettlement.txHash,
        explorerUrl: `https://sepolia.etherscan.io/tx/${escrowSettlement.txHash}`,
      },
      report: null,
      note: process.env.NUGGET_LOCAL_CRE_SIMULATION === "true"
        ? "Local CRE simulation: it executes the same encrypted-data, eligibility, Merkle-root, and claim-proof logic, but it is not a Chainlink TEE or DON."
        : "CRE simulation: fetch ciphertext → decrypt in handlerInTee → aggregate → public stats only.",
    })
  } finally {
    isRunning = false
  }
}
