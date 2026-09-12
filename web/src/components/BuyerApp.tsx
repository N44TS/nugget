"use client"

import Link from "next/link"
import { usePrivy, useSendTransaction } from "@privy-io/react-auth"
import { useEffect, useState, useTransition } from "react"
import { encodeFunctionData, formatEther } from "viem"
import { payoutWindowId } from "@/lib/cycle"
import { batchCommitment, nuggetBatchEscrowAbi, purchaseBatchId } from "@/lib/escrow"

const paymentTreasury = process.env.NEXT_PUBLIC_BUYER_PAYMENT_TREASURY ?? ""
const escrowAddress = process.env.NEXT_PUBLIC_NUGGET_BATCH_ESCROW_ADDRESS ?? ""
const paymentWei = process.env.NEXT_PUBLIC_BUYER_PAYMENT_WEI ?? "1000000000000000"
const paymentEth = (() => {
  try {
    return formatEther(BigInt(paymentWei))
  } catch {
    return "configured amount"
  }
})()

type PublicReport = {
  batchId: string
  contributorCount: number
  avgCycleLength: number | null
  avgPeriodLength: number | null
  symptomRates: Record<string, number> | null
  ageBandShare: Record<string, number> | null
  avgCycleByAgeBand: Record<string, number> | null
  rejectedCount: number
  kMin: number
  kAnonOk?: boolean
  rewardRoot?: string | null
  eligibleWallets?: number
}

type BuyerReport = {
  txHash: string
  buyerAddress: string
  amountWei: string
  batchId: string | null
  createdAt: string
  reportSummary: string
}

type RunCreResponse = {
  ok?: boolean
  error?: string
  creSummary?: string
  source?: string
  note?: string
  creLogTail?: string
  dataDir?: string
  report?: PublicReport | null
  poolSize?: number
  claimIds?: string[]
  payment?: {
    txHash: string
    status: string
    explorerUrl: string
  }
  rewardAccounting?: {
    batchId: string
    contributorCount: number
    walletCount: number
    rewardPoolWei: string
    perWalletWei: string | null
    status: string
  } | null
  payout?: {
    status: string
    payouts: Array<{ amountWei: string; transactionHash: string }>
    error?: string
  } | null
  escrowSettlement?: {
    txHash: string
    explorerUrl: string
  } | null
}

const parseReportMap = (value: string): Record<string, number> | null => {
  const entries = value.split(",").filter(Boolean).map((entry) => entry.split(":"))
  return entries.length ? Object.fromEntries(entries.map(([key, number]) => [key, Number(number)])) : null
}

const parseStoredReport = (summary: string): PublicReport | null => {
  const suppressed = summary.match(/^SUPPRESSED batch=(\S+) n=(\d+) kMin=(\d+)/)
  if (suppressed) {
    return {
      batchId: suppressed[1]!,
      contributorCount: Number(suppressed[2]),
      avgCycleLength: null,
      avgPeriodLength: null,
      symptomRates: null,
      ageBandShare: null,
      avgCycleByAgeBand: null,
      rejectedCount: 0,
      kMin: Number(suppressed[3]),
      kAnonOk: false,
      rewardRoot: null,
      eligibleWallets: 0,
    }
  }
  const match = summary.match(
    /^OK batch=(\S+) n=(\d+) avgCycle=([\d.]+) avgPeriod=([\d.]+) symptoms=\{([^}]*)\} ageShare=\{([^}]*)\} avgCycleByAge=\{([^}]*)\} kAnon=passed rejected=(\d+) rewardRoot=(\S+) eligibleWallets=(\d+)/,
  )
  if (!match) return null
  return {
    batchId: match[1]!,
    contributorCount: Number(match[2]),
    avgCycleLength: Number(match[3]),
    avgPeriodLength: Number(match[4]),
    symptomRates: parseReportMap(match[5]),
    ageBandShare: parseReportMap(match[6]),
    avgCycleByAgeBand: parseReportMap(match[7]),
    rejectedCount: Number(match[8]),
    kMin: 2,
    kAnonOk: true,
    rewardRoot: match[9] === "none" ? null : match[9]!,
    eligibleWallets: Number(match[10]),
  }
}

export function BuyerApp() {
  const { authenticated, user } = usePrivy()
  const { sendTransaction } = useSendTransaction()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<RunCreResponse | null>(null)
  const [previousReports, setPreviousReports] = useState<BuyerReport[]>([])
  const wallet = user?.linkedAccounts.find((account) => account.type === "wallet")

  useEffect(() => {
    if (!wallet?.address) {
      setPreviousReports([])
      return
    }
    fetch(`/api/buyer/reports?buyerAddress=${encodeURIComponent(wallet.address)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return
        const data = (await response.json()) as { reports?: BuyerReport[] }
        setPreviousReports(data.reports ?? [])
      })
      .catch(() => undefined)
  }, [wallet?.address])

  const openPreviousReport = (report: BuyerReport) => {
    if (!report.reportSummary) return
    setError(null)
    setStatus(null)
    setResult({
      ok: true,
      source: "stored-buyer-report",
      creSummary: report.reportSummary,
      report: parseStoredReport(report.reportSummary),
      payment: {
        txHash: report.txHash,
        status: "completed",
        explorerUrl: `https://sepolia.etherscan.io/tx/${report.txHash}`,
      },
      note: "Stored report snapshot from a completed Sepolia payment.",
    })
  }

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
        const usesEscrow = /^0x[a-fA-F0-9]{40}$/.test(escrowAddress)
        if (!usesEscrow && !paymentTreasury) {
          setError(
            "Buyer payment destination is not configured. Add NEXT_PUBLIC_NUGGET_BATCH_ESCROW_ADDRESS (recommended) or NEXT_PUBLIC_BUYER_PAYMENT_TREASURY in Render and redeploy.",
          )
          return
        }
        const payoutWindow = payoutWindowId()
        // let batchId = payoutWindow
        // if (usesEscrow) {
        //   const poolResponse = await fetch("/api/pool/verify", { cache: "no-store" })
        //   const poolData = (await poolResponse.json()) as { pool?: { batchId?: string }; error?: string }
        //   if (!poolResponse.ok || !poolData.pool?.batchId) {
        //     setError(poolData.error ?? "The contribution pool is empty. Wait for contributors before funding a batch.")
        //     return
        //   }
        //   batchId = poolData.pool.batchId
       // }
        setStatus(usesEscrow ? "Fund this confidential research purchase in your Privy wallet…" : "Approve the Sepolia report fee in your Privy wallet…")
        const purchaseId = purchaseBatchId(payoutWindow, crypto.randomUUID())
        const payment = await sendTransaction({
          to: (usesEscrow ? escrowAddress : paymentTreasury) as `0x${string}`,
          value: paymentWei,
          chainId: 11155111,
          ...(usesEscrow
            ? {
                data: encodeFunctionData({
                  abi: nuggetBatchEscrowAbi,
                  functionName: "fundBatch",
                  args: [batchCommitment(purchaseId)],
                }),
              }
            : {}),
        })
        setStatus("Payment sent. Waiting for confirmation before running CRE…")
        const res = await fetch("/api/buyer/run-cre", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentTxHash: payment.hash, payoutWindowId: payoutWindow, purchaseId }),
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
  return (
    <div className="stack">
      <p className="lede">
        <Link href="/">← Contributor app</Link>
      </p>

      <section className="panel">
        <div className="buyer-price" aria-label={`Report price ${paymentEth} Sepolia ETH`}>
          <span className="eyebrow">Buyer report price</span>
          <strong>{paymentEth} ETH</strong>
          <span>Paid on Sepolia. The current encrypted pool is aggregated privately by CRE.</span>
        </div>
        {authenticated && wallet && (
          <p className="muted">
            Fund this embedded wallet with Sepolia ETH for the report value before paying:
            {" "}
            <a href="https://sepoliafaucet.com/" target="_blank" rel="noreferrer">
              Open Sepolia faucet
            </a>
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="button" className="btn accent" disabled={pending} onClick={onRun}>
            {pending ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Running CRE…
              </>
            ) : (
              "Pay and run CRE report"
            )}
          </button>
        </div>
      </section>

      {previousReports.length > 0 && (
        <section className="panel" aria-labelledby="previous-reports-heading">
          <h2 id="previous-reports-heading">Previous reports</h2>
          <p className="muted">Paid report snapshots saved to your buyer wallet.</p>
          <ul className="history">
            {previousReports.map((report) => (
              <li key={report.txHash}>
                <span className="range">{new Date(report.createdAt).toLocaleString()}</span>
                <button type="button" className="btn secondary" onClick={() => openPreviousReport(report)}>
                  Open report
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {status && <p className="banner ok" role="status">{status}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}
      {result?.payment && (
        <section className="panel">
          <h2>Payment confirmed</h2>
          <p className="muted">
            Report access: {result.payment.status}.{" "}
            <a href={result.payment.explorerUrl} target="_blank" rel="noreferrer">
              View transaction on Etherscan
            </a>
          </p>
        </section>
      )}
      {result?.rewardAccounting && (
        <section className="panel">
          <h2>Contributor reward accounting</h2>
          <p className="muted">
            Batch {result.rewardAccounting.batchId}: {result.rewardAccounting.status}.
            {" "}
            {result.rewardAccounting.walletCount} eligible wallets,
            {" "}
            {result.rewardAccounting.perWalletWei
              ? `${result.rewardAccounting.perWalletWei} wei allocated per wallet.`
              : "held until the privacy thresholds are met."}
          </p>
        </section>
      )}
      {result?.payout && (
        <section className="panel">
          <h2>Contributor payout settlement</h2>
          <p className="muted">
            {result.payout.status === "paid"
              ? `${result.payout.payouts.length} payout(s) confirmed on Sepolia.`
              : result.payout.error ?? "Payouts are held until the privacy thresholds and treasury setup are ready."}
          </p>
          {result.payout.payouts.map((payout) => (
            <p className="muted" key={payout.transactionHash}>
              <a
                href={`https://sepolia.etherscan.io/tx/${payout.transactionHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View payout transaction
              </a>
            </p>
          ))}
        </section>
      )}
      {result?.escrowSettlement && (
        <section className="panel">
          <h2>Rewards settled in escrow</h2>
          <p className="muted">
            The contract now holds this batch&apos;s funds. Eligible contributors claim directly, once each.
            {" "}
            <a href={result.escrowSettlement.explorerUrl} target="_blank" rel="noreferrer">View settlement transaction</a>
          </p>
        </section>
      )}

      {result?.creSummary && (
        result.report && (
          <section className="panel research-report">
            <p className="step-label">RESEARCH BRIEF</p>
            <h2>Nugget cohort report</h2>
            <p className="lede">
              A descriptive aggregate of the current rolling research pool. Individual records are not included in this report.
            </p>
            <div className="report-meta">
              <span>Scope <strong>{result.report.batchId}</strong></span>
              <span>Privacy threshold <strong>k = {result.report.kMin}</strong></span>
              <span>Quality checks <strong>{result.report.rejectedCount} excluded</strong></span>
            </div>
            <div className="report-grid">
              <div className="report-stat"><strong>{result.report.contributorCount}</strong><span>valid contributors</span></div>
              <div className="report-stat"><strong>{result.report.eligibleWallets ?? 0}</strong><span>eligible reward wallets</span></div>
              <div className="report-stat"><strong>{result.report.kAnonOk ? "Passed" : "Suppressed"}</strong><span>k-anonymity</span></div>
            </div>
            <div className="report-section">
              <h3>What this report says</h3>
              <ul className="report-findings">
                <li>Average cycle length: <strong>{result.report.avgCycleLength ?? "suppressed"} days</strong></li>
                <li>Average period length: <strong>{result.report.avgPeriodLength ?? "suppressed"} days</strong></li>
                <li>Symptoms reported by at least k contributors: <strong>{Object.entries(result.report.symptomRates ?? {}).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(", ") || "none disclosed"}</strong></li>
              </ul>
            </div>
            <div className="report-section">
              <h3>Cohort composition</h3>
              <ul className="report-findings">
                <li>Age-band share: <strong>{Object.entries(result.report.ageBandShare ?? {}).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(", ") || "suppressed"}</strong></li>
                <li>Average cycle by age band: <strong>{Object.entries(result.report.avgCycleByAgeBand ?? {}).map(([key, value]) => `${key} ${value} days`).join(", ") || "suppressed"}</strong></li>
              </ul>
            </div>
            <div className="report-section">
              <h3>Research limitations</h3>
              <p className="muted">These are descriptive, k-anonymous aggregates from a rolling pool, not individual-level data or clinical advice. Some categories are withheld when the privacy threshold is not met.</p>
            </div>
          </section>
        )
      )}

      {result?.creSummary && (
        <section className="panel">
          <h2>CRE raw output</h2>
          <p className="muted">Technical output from the official confidential workflow simulation.</p>
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
