"use client"

import Link from "next/link"
import { usePrivy, useSendTransaction } from "@privy-io/react-auth"
import { useState, useTransition } from "react"

const paymentTreasury = process.env.NEXT_PUBLIC_BUYER_PAYMENT_TREASURY ?? ""
const paymentWei = process.env.NEXT_PUBLIC_BUYER_PAYMENT_WEI ?? "1000000000000000"

type RunCreResponse = {
  ok?: boolean
  error?: string
  creSummary?: string
  source?: string
  note?: string
  creLogTail?: string
  dataDir?: string
  report?: {
    batchId: string
    contributorCount: number
    avgCycleLength: number | null
    avgPeriodLength: number | null
    symptomRates: Record<string, number> | null
    ageBandShare: Record<string, number> | null
    avgCycleByAgeBand: Record<string, number> | null
    rejectedCount: number
    kMin: number
  } | null
  poolSize?: number
  claimIds?: string[]
}

export function BuyerApp() {
  const { authenticated, user } = usePrivy()
  const { sendTransaction } = useSendTransaction()
  const [pending, startTransition] = useTransition()
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<RunCreResponse | null>(null)
  const wallet = user?.linkedAccounts.find((account) => account.type === "wallet")

  const onRun = () => {
    setError(null)
    setStatus(null)
    setResult(null)
    startTransition(async () => {
      try {
        if (!authenticated) {
          setError("Sign in as the buyer organization before requesting a report")
          return
        }
        if (!paymentTreasury) {
          setError(
            "Buyer payment treasury is not configured. Add NEXT_PUBLIC_BUYER_PAYMENT_TREASURY in Render and redeploy.",
          )
          return
        }
        setStatus("Approve the Sepolia report fee in your Privy wallet…")
        const payment = await sendTransaction({
          to: paymentTreasury,
          value: paymentWei,
          chainId: 11155111,
        })
        setStatus("Payment sent. Waiting for confirmation before running CRE…")
        const res = await fetch("/api/buyer/run-cre", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentTxHash: payment.hash }),
        })
        const data = (await res.json()) as RunCreResponse
        if (!res.ok || !data.ok) {
          setError(data.error ?? "CRE run failed")
          if (data.creLogTail) setResult(data)
          return
        }
        setResult(data)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Payment or CRE request failed")
      }
    })
  }

  const onReset = () => {
    setError(null)
    setResult(null)
    setResetting(true)
    startTransition(async () => {
      try {
        const res = await fetch("/api/pool/reset", { method: "POST" })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error ?? "Reset failed")
        } else {
          setStatus("Pool cleared. Opt in again from :3000 and :3001, then run CRE.")
        }
      } catch {
        setError("Network error on reset")
      } finally {
        setResetting(false)
      }
    })
  }

  return (
    <div className="stack">
      <p className="lede">
        <Link href="/">← Contributor app</Link>
      </p>

      <section className="panel">
        <h2>How to use (real data only)</h2>
        <p className="lede">
          1. Start two servers: <code>bun dev --port 3000</code> and <code>bun dev --port 3001</code>
          <br />
          2. On each port, set age band, log a period, <strong>Opt in</strong> (they share one pool)
          <br />
          3. Open <code>/buyer</code> on either port → <strong>Run CRE aggregation</strong>
          <br />
          Do <strong>not</strong> run <code>bun run basic-flow</code> — that script invents test users.
        </p>
        {authenticated && wallet && (
          <p className="muted">
            Fund this embedded wallet with Sepolia ETH before paying:
            {" "}
            <a href="https://sepoliafaucet.com/" target="_blank" rel="noreferrer">
              Open Sepolia faucet
            </a>
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="button" className="btn accent" disabled={pending} onClick={onRun}>
            {pending && !resetting ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Running CRE…
              </>
            ) : (
              "Pay and run CRE report"
            )}
          </button>
          <button type="button" className="btn primary" disabled={pending || resetting} onClick={onReset}>
            {resetting ? "Clearing…" : "Clear pool"}
          </button>
        </div>
      </section>

      {status && <p className="banner ok" role="status">{status}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}

      {result?.creSummary && (
        <section className="panel">
          <h2>CRE output</h2>
          <pre className="cre-out">{result.creSummary}</pre>
          {result.note && <p className="muted">{result.note}</p>}
          {result.dataDir && <p className="muted">Shared pool dir: {result.dataDir}</p>}
        </section>
      )}

      {result?.report && (
        <section className="panel">
          <h2>Insight report</h2>
          <ul className="history">
            <li>
              <span className="range">Contributors (n)</span>
              <span className="syms">
                {result.report.contributorCount}
                {result.poolSize != null ? ` (pool file: ${result.poolSize})` : ""}
              </span>
            </li>
            <li>
              <span className="range">Avg cycle / period</span>
              <span className="syms">
                {result.report.avgCycleLength}d / {result.report.avgPeriodLength}d
              </span>
            </li>
            <li>
              <span className="range">Symptoms</span>
              <span className="syms">
                {Object.entries(result.report.symptomRates ?? {})
                  .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
                  .join(", ") || "—"}
              </span>
            </li>
            <li>
              <span className="range">Age band share</span>
              <span className="syms">
                {Object.entries(result.report.ageBandShare ?? {})
                  .map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
                  .join(", ") || "—"}
              </span>
            </li>
            <li>
              <span className="range">Avg cycle by age</span>
              <span className="syms">
                {Object.entries(result.report.avgCycleByAgeBand ?? {})
                  .map(([k, v]) => `${k}: ${v}d`)
                  .join(", ") || "—"}
              </span>
            </li>
          </ul>
        </section>
      )}

      {result?.creLogTail && !result.ok && (
        <section className="panel">
          <h2>CRE log (tail)</h2>
          <pre className="cre-out">{result.creLogTail}</pre>
        </section>
      )}
    </div>
  )
}
