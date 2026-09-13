"use client"

import Link from "next/link"
import { usePrivy, useSendTransaction } from "@privy-io/react-auth"
import { useEffect, useState, useTransition } from "react"
import { encodeFunctionData, formatEther } from "viem"
import { payoutWindowId } from "@/lib/cycle"
import { batchCommitment, nuggetBatchEscrowAbi, purchaseBatchId } from "@/lib/escrow"
import { RewardWalletPreview } from "@/components/RewardWalletPreview"

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
  wellbeingDistributions: Record<string, Record<string, number>> | null
  coOccurrenceRates: Record<string, number> | null
  ageBandStats: Record<string, SegmentStats> | null
  cycleLengthStats: Record<string, SegmentStats> | null
  moderateSeverePainRate: number | null
  rejectedCount: number
  kMin: number
  kAnonOk?: boolean
  rewardRoot?: string | null
  eligibleWallets?: number
}

type SegmentStats = {
  count: number
  share: number
  avgCycle: number
  avgPeriod: number
  moderateSeverePain: number | null
  irregularCycle: number
  wellbeingCount: number
  moderateSeverePainCount: number
  heavyBleeding: number | null
  poorSleep: number | null
  skinFlare: number | null
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

const parseReportMap = (value?: string): Record<string, number> | null => {
  if (!value) return null
  const entries = value.split(",").filter(Boolean).map((entry) => entry.split(":"))
  return entries.length ? Object.fromEntries(entries.map(([key, number]) => [key, Number(number)])) : null
}

const parseWellbeingMap = (value?: string): Record<string, Record<string, number>> | null => {
  if (!value) return null
  const parsed: Record<string, Record<string, number>> = {}
  for (const entry of value.split(",").filter(Boolean)) {
    const [field, category, number] = entry.split(/[.:]/)
    if (!field || !category || !number) continue
    parsed[field] ??= {}
    parsed[field][category] = Number(number)
  }

  return Object.keys(parsed).length ? parsed : null
}

const parseSegmentStats = (value?: string): Record<string, SegmentStats> | null => {
  if (!value) return null
  const parsed: Record<string, SegmentStats> = {}
  for (const entry of value.split(",").filter(Boolean)) {
    const [key, encoded] = entry.split(":")
    const [count, share, avgCycle, avgPeriod, pain, irregularCycle, wellbeingCount, moderateSeverePainCount, heavyBleeding, poorSleep, skinFlare] = (encoded ?? "").split("|").map(Number)
    if (!key || !Number.isFinite(count) || !Number.isFinite(share) || !Number.isFinite(avgCycle) || !Number.isFinite(avgPeriod) || !Number.isFinite(irregularCycle)) continue
    parsed[key] = {
      count,
      share,
      avgCycle,
      avgPeriod,
      moderateSeverePain: Number.isFinite(pain) ? pain : null,
      irregularCycle,
      wellbeingCount: Number.isFinite(wellbeingCount) ? wellbeingCount : 0,
      moderateSeverePainCount: Number.isFinite(moderateSeverePainCount) ? moderateSeverePainCount : 0,
      heavyBleeding: Number.isFinite(heavyBleeding) ? heavyBleeding : null,
      poorSleep: Number.isFinite(poorSleep) ? poorSleep : null,
      skinFlare: Number.isFinite(skinFlare) ? skinFlare : null,
    }
  }
  return Object.keys(parsed).length ? parsed : null
}

const coOccurrenceLabels: Record<string, string> = {
  sleepGood_skinClear: "Good Sleep × Clear Skin",
  bleedingHeavy_painModerateOrWorse: "Heavy Bleeding × Moderate-to-Severe Pain",
  skinFlare_moodLow: "Skin Flare-up × Low Mood",
  painModerateOrWorse_skinFlare: "Moderate-to-Severe Pain × Skin Flare-up",
}

const describePrimarySignal = (rates: Record<string, number> | null): string => {
  if (!rates) return "No signal combination met the privacy threshold in this report."
  const [pair, value] = Object.entries(rates).sort(([, a], [, b]) => b - a)[0] ?? []
  if (!pair || value == null) return "No signal combination met the privacy threshold in this report."
  return `${coOccurrenceLabels[pair] ?? pair} was observed in ${Math.round(value * 100)}% of the relevant supplied wellbeing records. This is an observed association in this cohort, not a causal or epidemiological risk estimate.`
}

const describeCoOccurrence = (pair: string, value: number): string =>
  `${Math.round(value * 100)}% of the relevant supplied wellbeing records included this combination.`

const largestAgeBand = (shares: Record<string, number> | null): string => {
  const [band] = Object.entries(shares ?? {}).sort(([, a], [, b]) => b - a)[0] ?? []
  return band ?? "—"
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
      wellbeingDistributions: null,
      coOccurrenceRates: null,
      ageBandStats: null,
      cycleLengthStats: null,
      moderateSeverePainRate: null,
      rejectedCount: 0,
      kMin: Number(suppressed[3]),
      kAnonOk: false,
      rewardRoot: null,
      eligibleWallets: 0,
    }
  }
  const match = summary.match(
    /^OK batch=(\S+) n=(\d+) avgCycle=([\d.]+) avgPeriod=([\d.]+) symptoms=\{([^}]*)\} ageShare=\{([^}]*)\} avgCycleByAge=\{([^}]*)\} kAnon=passed rejected=(\d+) rewardRoot=(\S+) eligibleWallets=(\d+)(?: wellbeing=\{([^}]*)\} coOccurrence=\{([^}]*)\})?(?: ageStats=\{([^}]*)\} cycleStats=\{([^}]*)\})?(?: painRate=([^ ]+))?/,
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
    wellbeingDistributions: parseWellbeingMap(match[11]),
    coOccurrenceRates: parseReportMap(match[12]),
    ageBandStats: parseSegmentStats(match[13]),
    cycleLengthStats: parseSegmentStats(match[14]),
    moderateSeverePainRate: match[15] && match[15] !== "x" ? Number(match[15]) : null,
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
  const [ageFilter, setAgeFilter] = useState("all")
  const [cycleFilter, setCycleFilter] = useState("all")
  const [correlationFilter, setCorrelationFilter] = useState("")
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
      // note: "Stored report snapshot from a completed Sepolia payment.",
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

  const report = result?.report
  const selectedSegment = report
    ? ageFilter !== "all"
      ? report.ageBandStats?.[ageFilter] ?? null
      : cycleFilter !== "all"
        ? report.cycleLengthStats?.[cycleFilter] ?? null
        : null
    : null
  const reportCycleLength = selectedSegment?.avgCycle ?? report?.avgCycleLength
  const reportPeriodLength = selectedSegment?.avgPeriod ?? report?.avgPeriodLength
  const reportContributorCount = selectedSegment?.count ?? report?.contributorCount

  const isStoredReport = result?.source === "stored-buyer-report"

  const renderReportContent = () => {
    if (!result) return null

    return (
      <>
        {result.payment && (
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
        {result.rewardAccounting && (
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
        {result.payout && (
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
        {result.escrowSettlement && (
          <section className="panel">
            <h2>Rewards settled in escrow</h2>
            <p className="muted">
              The contract now holds this batch&apos;s funds. Eligible contributors claim directly, once each.
              {" "}
              <a href={result.escrowSettlement.explorerUrl} target="_blank" rel="noreferrer">View settlement transaction</a>
            </p>
          </section>
        )}

        {result.creSummary && (
          result.report && (
            <section className="panel research-report">
              <div className="report-head">
                <div>
                  <p className="step-label">RESEARCH BRIEF</p>
                  <h2>Nugget Aggregated report</h2>
                </div>
              </div>
              <p className="lede">
                Anonymized multi-signal observations from the current rolling pool. Individual records are not included.
              </p>
              <div className="report-meta">
                <span>Batch <strong>{result.report.batchId}</strong></span>
                <span><strong>{reportContributorCount}</strong> valid contributions</span>
                <span>eligible reward wallets <strong>{result.report.eligibleWallets ?? 0}</strong></span>
                <span>Privacy threshold <strong>k = {result.report.kMin}</strong></span>
                <span>k-anonymity <strong>{result.report.kAnonOk ? "Passed" : "Suppressed"}</strong></span>
              </div>
              <div className="report-section">
                <h3>Key descriptive signals</h3>
                <p className="report-finding">
                  {describePrimarySignal(correlationFilter
                    ? { [correlationFilter]: result.report.coOccurrenceRates?.[correlationFilter] ?? 0 }
                    : result.report.coOccurrenceRates)}
                </p>
              </div>
              <div className="report-section">
                <h3>Cohort composition</h3>
                <ul className="report-findings">
                  <li>Age-band share: <strong>{Object.entries(result.report.ageBandShare ?? {}).map(([key, value]) => `${key}: ${Math.round(value * 100)}%`).join(", ") || "—"}</strong></li>
                  <li>Average cycle by age band: <strong>{Object.entries(result.report.avgCycleByAgeBand ?? {}).map(([key, value]) => `${key}: ${value} days`).join(", ") || "—"}</strong></li>
                  <li>Symptoms reported by at least k contributors: <strong>{Object.entries(result.report.symptomRates ?? {}).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(", ") || "none disclosed"}</strong></li>
                </ul>
              </div>
              <div className="report-section">
                <h3>Filters</h3>
                <div className="report-filters">
                  <label>Age band
                    <select value={ageFilter} onChange={(event) => setAgeFilter(event.target.value)}>
                      <option value="all">All age bands</option>
                      {Object.keys(result.report.ageBandStats ?? result.report.ageBandShare ?? {}).sort().map((band) => <option key={band} value={band}>{band}</option>)}
                    </select>
                  </label>
                  <label>Cycle length
                    <select value={cycleFilter} onChange={(event) => setCycleFilter(event.target.value)}>
                      <option value="all">All cycle profiles</option>
                      <option value="short">Short (&lt;25 days)</option>
                      <option value="typical">Typical (25–35 days)</option>
                      <option value="long">Long / irregular (&gt;35 days)</option>
                    </select>
                  </label>
                  <label>Correlation focus
                    <select value={correlationFilter} onChange={(event) => setCorrelationFilter(event.target.value)}>
                      <option value="">All observed combinations</option>
                      {Object.keys(result.report.coOccurrenceRates ?? {}).map((pair) => <option key={pair} value={pair}>{coOccurrenceLabels[pair] ?? pair}</option>)}
                    </select>
                  </label>
                </div>
              </div>
              
              <div className="report-grid">
                <div className="report-stat"><strong>{reportCycleLength ?? "—"}{reportCycleLength != null && "d"}</strong><span>average cycle length</span></div>
                <div className="report-stat"><strong>{reportPeriodLength ?? "—"}{reportPeriodLength != null && "d"}</strong><span>average period length</span></div>
                <div className="report-stat"><strong>{largestAgeBand(result.report.ageBandShare)}</strong><span>average age</span></div>
              </div>
              <div className="report-section">
                <h3>Signal co-occurrence and clustering</h3>
                <p className="lede">Observed combinations across the full supplied wellbeing cohort. These are descriptive shares, not relative-risk or causal estimates; age and cycle filters apply to the summary and cross-cut tables.</p>
                <div className="cluster-grid">
                  {Object.entries(result.report.coOccurrenceRates ?? {}).filter(([pair]) => !correlationFilter || pair === correlationFilter).map(([pair, value]) => (
                    <div className="cluster-card" key={pair}>
                      <div className="cluster-title">
                        <span>{coOccurrenceLabels[pair] ?? pair}</span>
                      </div>
                      <div className="cluster-stat">{Math.round(value * 100)}% co-occurrence</div>
                      <div className="cluster-desc">{describeCoOccurrence(pair, value)}</div>
                    </div>
                  ))}
                </div>
                {!result.report.coOccurrenceRates && <p className="muted">No signal combinations met the privacy threshold.</p>}
              </div>
              <div className="report-section">
                <h3>Demographic and cycle cross-cuts</h3>
                <p className="lede">Published only for age bands that meet the privacy threshold.</p>
                {result.report.ageBandShare && result.report.avgCycleByAgeBand ? (
                  <div className="table-wrap">
                    <table className="compact-table">
                      <thead><tr><th>Age band</th><th>Cohort share</th><th>Avg cycle</th><th>Avg period</th><th>Mod/severe pain</th><th>Irregular cycle (&gt;35d)</th></tr></thead>
                      <tbody>
                        {Object.keys(result.report.ageBandStats ?? result.report.ageBandShare).sort().filter((ageBand) => ageFilter === "all" || ageBand === ageFilter).map((ageBand) => (
                          <tr key={ageBand}>
                            <td><strong>{ageBand}</strong></td>
                            <td>{Math.round((result.report!.ageBandStats?.[ageBand]?.share ?? result.report!.ageBandShare?.[ageBand] ?? 0) * 100)}%</td>
                            <td>{result.report!.ageBandStats?.[ageBand]?.avgCycle ?? result.report!.avgCycleByAgeBand?.[ageBand] ?? "—"}{(result.report!.ageBandStats?.[ageBand]?.avgCycle ?? result.report!.avgCycleByAgeBand?.[ageBand]) != null && " days"}</td>
                            <td>{result.report!.ageBandStats?.[ageBand]?.avgPeriod ?? "—"}{result.report!.ageBandStats?.[ageBand]?.avgPeriod != null && " days"}</td>
                            <td>{result.report!.ageBandStats?.[ageBand]?.moderateSeverePain != null ? `${Math.round(result.report!.ageBandStats[ageBand]!.moderateSeverePain! * 100)}%` : "—"}</td>
                            <td>{result.report!.ageBandStats?.[ageBand]?.irregularCycle != null ? `${Math.round(result.report!.ageBandStats[ageBand]!.irregularCycle * 100)}%` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted">Age-band cross-cut data is not available.</p>}
                {result.report.cycleLengthStats && (
                  <>
                    <h4 className="cross-cut-heading">Cycle length &amp; clinical signals</h4>
                    <div className="table-wrap">
                      <table className="compact-table">
                        <thead>
                          <tr>
                            <th>Cycle profile</th>
                            <th>Cohort share</th>
                            <th>Avg period</th>
                            <th>Heavy flow rate</th>
                            <th>Poor sleep rate</th>
                            <th>Skin flare rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(result.report.cycleLengthStats)
                            .filter(([profile]) => cycleFilter === "all" || profile === cycleFilter)
                            .map(([profile, stats]) => (
                              <tr key={profile}>
                                <td><strong>{profile === "short" ? "Short (<25d)" : profile === "long" ? "Long / irregular (>35d)" : "Typical (25–35d)"}</strong></td>
                                <td>{Math.round(stats.share * 100)}%</td>
                                <td>{stats.avgPeriod} days</td>
                                <td>{stats.heavyBleeding != null ? `${Math.round(stats.heavyBleeding * 100)}%` : "—"}</td>
                                <td>{stats.poorSleep != null ? `${Math.round(stats.poorSleep * 100)}%` : "—"}</td>
                                <td>{stats.skinFlare != null ? `${Math.round(stats.skinFlare * 100)}%` : "—"}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
              <div className="report-section">
                <h3>Data quality and privacy</h3>
                <p className="muted">{result.report.rejectedCount} contributions excluded before aggregation. Categories and combinations below k are withheld; no individual record or contributor address is included.</p>
              </div>
            </section>
          )
        )}

        {result.creSummary && (
          <section className="panel">
            <h2>CRE raw output</h2>
            <p className="muted">Technical output from the confidential workflow simulation.</p>
            <pre className="cre-out">{result.creSummary}</pre>
            {result.note && <p className="muted">{result.note}</p>}
            {/* {result.dataDir && <p className="muted">Shared pool dir: {result.dataDir}</p>} */}
          </section>
        )}

        {result.report && (
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

        {result.creLogTail && !result.ok && (
          <section className="panel">
            <h2>CRE log (tail)</h2>
            <pre className="cre-out">{result.creLogTail}</pre>
          </section>
        )}
      </>
    )
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

      {status && <p className="banner ok" role="status">{status}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}

      {!isStoredReport && renderReportContent()}

      <RewardWalletPreview />

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

      {isStoredReport && renderReportContent()}
    </div>
  )
}
