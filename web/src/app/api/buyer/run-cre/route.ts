import { NextResponse } from "next/server"
import { spawn } from "child_process"
import { existsSync } from "fs"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { loadEncryptedPool, poolDataDir } from "@/lib/server-batch"

export const maxDuration = 120
const K_MIN = 2

async function runCreSimulate(poolFetchUrl: string) {
  const creBin = process.env.CRE_BIN || path.join(process.env.HOME || "", ".cre/bin/cre")
  const projectRoot = path.resolve(process.cwd(), "../cre-hello-confidential")
  const altRoot = path.resolve(process.cwd(), "cre-hello-confidential")
  const root = existsSync(path.join(projectRoot, "my-workflow")) ? projectRoot : altRoot
  const configPath = path.join(root, "my-workflow", "config.staging.json")
  const bunBin = path.join(process.env.HOME || "", ".bun/bin")
  const creDir = path.dirname(creBin)

  const previous = await readFile(configPath, "utf8")
  const config = JSON.parse(previous) as Record<string, unknown>
  config.url = poolFetchUrl
  config.kMin = K_MIN
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

  try {
    return await new Promise<{ ok: boolean; summary: string | null; log: string; error?: string }>(
      (resolve) => {
        const child = spawn(
          creBin,
          [
            "workflow",
            "simulate",
            "my-workflow",
            "--target",
            "staging-settings",
            "--non-interactive",
            "--trigger-index",
            "0",
          ],
          {
            cwd: root,
            env: { ...process.env, PATH: `${creDir}:${bunBin}:${process.env.PATH || ""}` },
          },
        )
        let out = ""
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString()
        })
        child.stderr.on("data", (d: Buffer) => {
          out += d.toString()
        })
        child.on("error", (err) => resolve({ ok: false, summary: null, log: out, error: err.message }))
        child.on("close", (code) => {
          const match = out.match(/Workflow Simulation Result:\s*\n?"([^"]+)"/)
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

  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "127.0.0.1:3000"
  const proto = request.headers.get("x-forwarded-proto") || "http"
  const poolFetchUrl = `${proto}://${host}/api/contributions/encrypted`

  const cre = await runCreSimulate(poolFetchUrl)
  if (!cre.ok || !cre.summary) {
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
}
