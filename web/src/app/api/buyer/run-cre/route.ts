import { NextResponse } from "next/server"
import { spawn } from "child_process"
import { existsSync } from "fs"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { loadEncryptedPool, poolDataDir } from "@/lib/server-batch"

export const maxDuration = 120
const K_MIN = 2
let isRunning = false
const SEPOLIA_CHAIN_ID = "0xaa36a7"

async function verifyPayment(txHash: string) {
  const treasury = (
    process.env.BUYER_PAYMENT_TREASURY ||
    process.env.NEXT_PUBLIC_BUYER_PAYMENT_TREASURY
  )?.toLowerCase()
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
  const requiredWei =
    process.env.BUYER_PAYMENT_WEI ||
    process.env.NEXT_PUBLIC_BUYER_PAYMENT_WEI ||
    "1000000000000000"
  if (!treasury || !rpcUrl || !requiredWei) {
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
    treasury,
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
    to?: string
    value?: string
    chainId?: string
  } | null
  if (!transaction) throw new Error("Payment transaction was not found yet")
  if (transaction.chainId?.toLowerCase() !== SEPOLIA_CHAIN_ID) {
    throw new Error("Payment must be made on Ethereum Sepolia")
  }
  if (transaction.to?.toLowerCase() !== treasury) {
    throw new Error("Payment recipient does not match the configured treasury")
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
}

async function runCreSimulate(poolFetchUrl: string) {
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
        child.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString()
          out += chunk
          console.log("[cre stdout]", chunk.trimEnd())
        })
        child.stderr.on("data", (d: Buffer) => {
          const chunk = d.toString()
          out += chunk
          console.error("[cre stderr]", chunk.trimEnd())
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
            log: out.slice(-4000),
            error: code === 0 ? undefined : `cre exited ${code}`,
          })
        })
      },
    )
  } finally {
    await writeFile(configPath, previous, "utf8")
  }
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
    const body = (await request.json().catch(() => ({}))) as { paymentTxHash?: string }
    if (!body.paymentTxHash) {
      return NextResponse.json({ ok: false, error: "A confirmed buyer payment is required" }, { status: 402 })
    }
    try {
      await verifyPayment(body.paymentTxHash)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment verification failed"
      console.error("[buyer] payment verification failed", {
        error: message,
        transaction: body.paymentTxHash,
      })
      return NextResponse.json({ ok: false, error: message }, { status: 402 })
    }
    console.log("[buyer] payment verified", { transaction: body.paymentTxHash })
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

    let cre: Awaited<ReturnType<typeof runCreSimulate>>
    try {
      cre = await runCreSimulate(poolFetchUrl)
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

    console.log("[cre] aggregation complete", {
      poolSize: pool.contributions.length,
      summary: cre.summary,
    })
    return NextResponse.json({
      ok: true,
      source: "cre-workflow-simulate",
      poolFetchUrl,
      dataDir: poolDataDir(),
      poolSize: pool.contributions.length,
      creSummary: cre.summary,
      report: null,
      note: "Same CRE confidential path as cre-hello: fetch ciphertext → decrypt in handlerInTee → aggregate → public stats only.",
    })
  } finally {
    isRunning = false
  }
}