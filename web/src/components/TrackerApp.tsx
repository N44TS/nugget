"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { ContributorRewardWallet } from "@/components/ContributorRewardWallet"
import { daysBetween, entryToContribution, newClaimId } from "@/lib/cycle"
import { base64ToBytes, encryptForCre } from "@/lib/crypto"
import { loadEntries, loadReceipts, saveEntries, saveLocalReceipt, type LocalReceipt } from "@/lib/storage"
import {
  AGE_BAND_OPTIONS,
  SYMPTOM_OPTIONS,
  type AgeBand,
  type CycleEntry,
  type Symptom,
  type WellbeingSignals,
} from "@/lib/types"

const today = () => new Date().toISOString().slice(0, 10)
const AGE_KEY = "nugget.profile.ageBand.v1"
const CONTRIBUTED_ENTRY_IDS_KEY = "nugget.contributions.entryIds.v1"
const RESEARCH_OPT_IN_KEY = "nugget.research.optedIn.v1"
const REWARD_WALLET_KEY = "nugget.rewardWallet.address.v1"

const WELLBEING_OPTIONS: {
  key: keyof WellbeingSignals
  label: string
  hint: string
  values: string[]
}[] = [
  { key: "energy", label: "Energy level", hint: "choose one", values: ["low", "okay", "good"] },
  { key: "mood", label: "Mood", hint: "choose one", values: ["low", "okay", "good"] },
  { key: "sleep", label: "Sleep quality", hint: "choose one", values: ["poor", "okay", "good"] },
  { key: "skin", label: "Skin condition", hint: "choose one", values: ["flare-up", "normal", "clear"] },
  { key: "bleeding", label: "Bleeding intensity", hint: "flow level", values: ["none", "spotting", "light", "medium", "heavy"] },
  { key: "pain", label: "Pain / cramps severity", hint: "choose one", values: ["none", "mild", "moderate", "strong", "severe"] },
]

const formatDateShort = (isoDate: string) => {
  try {
    const [y, m, d] = isoDate.split("-")
    if (!y || !m || !d) return isoDate
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" })
  } catch {
    return isoDate
  }
}

const isCompleteWellbeing = (signals: Partial<WellbeingSignals>): signals is WellbeingSignals =>
  WELLBEING_OPTIONS.every(({ key }) => typeof signals[key] === "string")

const loadContributedEntryIds = (): string[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONTRIBUTED_ENTRY_IDS_KEY) ?? "[]") as unknown
    return Array.isArray(saved) && saved.every((id) => typeof id === "string") ? saved : []
  } catch {
    return []
  }
}

type ContributeResponse = {
  ok?: boolean
  error?: string
  dataDir?: string
  receipt?: LocalReceipt
  pool?: {
    batchId: string
    size: number
    claimIds?: string[]
    kMin: number
    kAnonOk: boolean
  }
  cre?: { ran: boolean; reason: string }
}

export function TrackerApp({ showRewards = false }: { showRewards?: boolean }) {
  const [entries, setEntries] = useState<CycleEntry[]>([])
  const [receipts, setReceipts] = useState<LocalReceipt[]>([])
  const [ageBand, setAgeBand] = useState<AgeBand | "">("")
  const [periodStart, setPeriodStart] = useState(today())
  const [periodEnd, setPeriodEnd] = useState(today())
  const [symptoms, setSymptoms] = useState<Symptom[]>(["cramps"])
  const [wellbeing, setWellbeing] = useState<Partial<WellbeingSignals>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [poolSummary, setPoolSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contributedEntryIds, setContributedEntryIds] = useState<string[]>([])
  const [researchOptedIn, setResearchOptedIn] = useState(false)
  const [pending, startTransition] = useTransition()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setEntries(loadEntries())
    setReceipts(loadReceipts())
    const saved = localStorage.getItem(AGE_KEY) as AgeBand | null
    if (saved) setAgeBand(saved)
    setContributedEntryIds(loadContributedEntryIds())
    setResearchOptedIn(localStorage.getItem(RESEARCH_OPT_IN_KEY) === "true")
    setReady(true)
  }, [])

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.periodStart.localeCompare(a.periodStart)),
    [entries],
  )
  const latestEntryId = sorted[0]?.id
  const latestEntryAlreadyContributed = Boolean(
    latestEntryId && contributedEntryIds.includes(latestEntryId),
  )

  const cycleStats = useMemo(() => {
    if (sorted.length === 0) {
      return { count: 0, typicalCycle: "—", typicalPeriod: "—", insight: null }
    }
    const periodLengths = sorted.map((e) => daysBetween(e.periodStart, e.periodEnd))
    const avgPeriod = `${(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length).toFixed(1)}d`

    const chronological = [...sorted].sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    const cycleIntervals: number[] = []
    for (let i = 1; i < chronological.length; i++) {
      const prev = chronological[i - 1]!
      const curr = chronological[i]!
      const diffDays = Math.round(
        (new Date(`${curr.periodStart}T00:00:00Z`).getTime() -
          new Date(`${prev.periodStart}T00:00:00Z`).getTime()) /
          (24 * 60 * 60 * 1000),
      )
      if (diffDays >= 15 && diffDays <= 90) {
        cycleIntervals.push(diffDays)
      }
    }

    const typicalCycle =
      cycleIntervals.length > 0
        ? `${Math.round(cycleIntervals.reduce((a, b) => a + b, 0) / cycleIntervals.length)}d`
        : sorted.length === 1
          ? "28d"
          : "—"

    const allSymptoms = sorted.flatMap((e) => e.symptoms)
    const symptomFrequency: Record<string, number> = {}
    for (const s of allSymptoms) {
      symptomFrequency[s] = (symptomFrequency[s] ?? 0) + 1
    }
    const topSymptoms = Object.entries(symptomFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([s]) => s)

    let insight = `Personal pattern: Regular ${typicalCycle !== "—" ? `${typicalCycle} ` : ""}cycle with typical ${avgPeriod} duration.`
    if (topSymptoms.length > 0) {
      insight += ` Cramps/symptoms commonly logged: ${topSymptoms.join(", ")}.`
    }

    return {
      count: sorted.length,
      typicalCycle,
      typicalPeriod: avgPeriod,
      insight,
    }
  }, [sorted])

  const toggleSymptom = (id: Symptom) => {
    setSymptoms((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  const setWellbeingValue = (key: keyof WellbeingSignals, value: string) => {
    setWellbeing((prev) => ({ ...prev, [key]: value }))
  }

  const persist = (next: CycleEntry[]) => {
    setEntries(next)
    saveEntries(next)
  }

  const onSave = () => {
    setError(null)
    setPoolSummary(null)
    if (periodEnd < periodStart) {
      setError("Period end must be on or after start.")
      return
    }
    if (!isCompleteWellbeing(wellbeing)) {
      setError("Complete each wellbeing signal before saving this period.")
      return
    }
    const entry: CycleEntry = {
      id: crypto.randomUUID(),
      periodStart,
      periodEnd,
      symptoms,
      wellbeing,
      createdAt: new Date().toISOString(),
    }
    persist([entry, ...entries])
    setSaveStatus(
      researchOptedIn && ageBand
        ? "Saved privately. Your research consent is active, so we are adding this anonymous summary to the current batch."
        : "Saved privately on this device. Nothing has been uploaded.",
    )
    if (researchOptedIn && ageBand) onContribute([entry, ...entries], entry.id, false)
  }

  const onContribute = (
    entriesToContribute = entries,
    entryId = latestEntryId,
    enableOngoingConsent = true,
  ) => {
    setError(null)
    setStatus(null)
    setPoolSummary(null)
    if (entryId && contributedEntryIds.includes(entryId)) {
      if (enableOngoingConsent) {
        setResearchOptedIn(true)
        localStorage.setItem(RESEARCH_OPT_IN_KEY, "true")
        setStatus("Research consent is active. New cycles will contribute an anonymous summary automatically when you save them.")
      }
      return
    }
    if (!ageBand) {
      setError("Select an age band before opting in. (Band only — not your date of birth.)")
      return
    }
    startTransition(async () => {
      localStorage.setItem(AGE_KEY, ageBand)
      const claimId = newClaimId()
      const contribution = entryToContribution(entriesToContribute, claimId, ageBand)
      if (!contribution) {
        setError("Log at least one period before contributing.")
        return
      }
      try {
        const keyRes = await fetch("/api/crypto/public-key", { cache: "no-store" })
        const keyData = (await keyRes.json()) as { publicKey?: string; error?: string }
        if (!keyRes.ok || !keyData.publicKey) {
          setError(keyData.error ?? "CRE encryption key unavailable")
          return
        }
        const encryptedContribution = encryptForCre(
          JSON.stringify(contribution),
          base64ToBytes(keyData.publicKey),
        )
        const res = await fetch("/api/contribute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contribution: encryptedContribution, claimId }),
        })
        const data = (await res.json()) as ContributeResponse
        if (!res.ok || !data.ok || !data.receipt || !data.pool) {
          setError(data.error ?? "Contribute failed")
          return
        }

        // Once a contributor has chosen a separate reward wallet, bind every
        // later opted-in contribution to it inside the same CRE-encrypted
        // payload. The server cannot turn a wallet into an eligible claim.
        const rewardWallet = localStorage.getItem(REWARD_WALLET_KEY)
        if (rewardWallet && /^0x[a-fA-F0-9]{40}$/.test(rewardWallet)) {
          try {
            const registration = encryptForCre(
              JSON.stringify({ claimId, walletAddress: rewardWallet }),
              base64ToBytes(keyData.publicKey),
            )
            await fetch("/api/rewards/opt-in", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                walletAddress: rewardWallet,
                claimId,
                batchId: data.receipt.batchId,
                registration,
              }),
            })
          } catch {
            // The health contribution was safely stored; retrying registration
            // should not make it appear that the private entry failed to save.
          }
        }

        setReceipts(saveLocalReceipt(data.receipt))
        if (entryId) {
          const nextContributedEntryIds = [...new Set([...contributedEntryIds, entryId])]
          setContributedEntryIds(nextContributedEntryIds)
          localStorage.setItem(CONTRIBUTED_ENTRY_IDS_KEY, JSON.stringify(nextContributedEntryIds))
        }
        if (enableOngoingConsent) {
          setResearchOptedIn(true)
          localStorage.setItem(RESEARCH_OPT_IN_KEY, "true")
        }
        setStatus(
          `${enableOngoingConsent ? "Research consent is active." : "Anonymous summary added."} ` +
            `Pool size now ${data.pool?.size ?? "?"}. New saved cycles will contribute automatically while consent remains active.`,
        )
        if (data.pool?.size) {
          setPoolSummary(`Shared pool has ${data.pool.size} real contribution(s). dataDir: ${data.dataDir ?? "?"}`)
        }
      } catch {
        setError("Network error while contributing.")
      }
    })
  }

  const onOptOut = () => {
    setResearchOptedIn(false)
    localStorage.removeItem(RESEARCH_OPT_IN_KEY)
    setStatus("Research consent is paused. Your existing anonymous contributions remain in their batches; future cycles will stay private.")
  }

  if (!ready) {
    return <p className="muted">Loading your private vault…</p>
  }

  return (
    <div className="stack tracker-flow">
      <p className="flow-tools">Testing research aggregates? <Link href="/buyer">Open the buyer console →</Link></p>

     

      <section className="panel step-panel profile-panel" aria-labelledby="log-heading">
        <p className="step-label">PRIVATE LOG</p>
        <h2 id="log-heading">Log a period</h2>
        <p className="lede">This is encrypted on this device. Saving it does <strong>not</strong> upload anything.</p>

        <div className="fields">
          <label>
            Start
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <label>
            End
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
        </div>

        <div style={{ marginTop: "1rem" }}>
          <div className="signal-grid">
            <div className="signal">
              <div className="signal-head">
                <span className="signal-name">Symptoms</span>
                <span className="optional">select all</span>
              </div>
              <div className="scale">
                {SYMPTOM_OPTIONS.map((opt) => {
                  const on = symptoms.includes(opt.id)
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={on ? "selected" : ""}
                      aria-pressed={on}
                      onClick={() => toggleSymptom(opt.id)}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {WELLBEING_OPTIONS.map((signal) => (
              <div className="signal" key={signal.key}>
                <div className="signal-head">
                  <span className="signal-name">{signal.label}</span>
                  <span className="optional">{signal.hint}</span>
                </div>
                <div className="scale">
                  {signal.values.map((value) => {
                    const isSelected = wellbeing[signal.key] === value
                    return (
                      <button
                        key={value}
                        type="button"
                        className={isSelected ? "selected" : ""}
                        aria-pressed={isSelected}
                        onClick={() => setWellbeingValue(signal.key, value)}
                      >
                        {value}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <button type="button" className="btn primary" disabled={!isCompleteWellbeing(wellbeing)} onClick={onSave}>
          Save private entry
        </button>
        {saveStatus && <p className="inline-confirmation" role="status">{saveStatus}</p>}
      </section>

      <section className="panel history-panel" aria-labelledby="history-heading">
        <h2 id="history-heading">Your cycle history </h2>
        <p className="lede">Stored only on your device.</p>

        {sorted.length > 0 && (
          <>
            <div className="cycle-summary">
              <div className="cycle-stat"><strong>{cycleStats.count}</strong><span>entries</span></div>
              <div className="cycle-stat"><strong>{cycleStats.typicalCycle}</strong><span>typical cycle</span></div>
              <div className="cycle-stat"><strong>{cycleStats.typicalPeriod}</strong><span>typical period</span></div>
            </div>

            {cycleStats.insight && (
              <div className="pattern-insight">
                <strong>Personal pattern:</strong> {cycleStats.insight.replace(/^Personal pattern:\s*/, "")}
              </div>
            )}
          </>
        )}

        {sorted.length === 0 ? (
          <p className="muted">No entries yet. Log a period above to see your private local patterns.</p>
        ) : (
          <ul className="history-list">
            {sorted.map((e, idx) => {
              const flowDays = daysBetween(e.periodStart, e.periodEnd)
              const nextOlder = sorted[idx + 1]
              let cycleDays: number | null = null
              if (nextOlder) {
                cycleDays = Math.round(
                  (new Date(`${e.periodStart}T00:00:00Z`).getTime() -
                    new Date(`${nextOlder.periodStart}T00:00:00Z`).getTime()) /
                    (24 * 60 * 60 * 1000),
                )
              }
              return (
                <li key={e.id}>
                  <span className="range">
                    {formatDateShort(e.periodStart)} → {formatDateShort(e.periodEnd)}
                  </span>
                  <span className="syms">
                    {e.symptoms.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(", ") || "No symptoms"}
                  </span>
                  <span className="meta-tag">
                    {cycleDays != null ? `${cycleDays}d cycle · ` : ""}{flowDays}d flow
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="muted" style={{ marginTop: "1rem" }}>
          Research contributions stay completely separate from this private view.
        </p>
      </section>

       <section className="panel step-panel log-panel" aria-labelledby="profile-heading">
        <p className="step-label">PROFILE</p>
        <h2 id="profile-heading">Choose an age band</h2>
        <p className="lede">This is not needed for private tracking. It is only used if you ever want to contribute an anonymous summary — never your name or any personal indentifiers</p>
        <div className="chips">
          {AGE_BAND_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={ageBand === opt.id ? "chip on" : "chip"}
              aria-pressed={ageBand === opt.id}
              onClick={() => setAgeBand(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel step-panel optin-panel" aria-labelledby="optin-heading">
        <h2 id="optin-heading">Contribute to research</h2>
        <p className="lede">
          Your private diary never leaves this device. If you opt in, we send only an encrypted, anonymous summary of your cycle, symptoms, and wellbeing signals to a shared research batch.
        </p>
        <div className="batch-explainer">
          <strong>What is a batch?</strong>
          <span>It is a group of anonymous contributions collected together. Researchers can only request group-level statistics once the privacy threshold is met — never individual entries.</span>
        </div>
        {receipts.length > 0 && (
          <ul className="history">
            {receipts.slice(0, 5).map((r) => (
              <li key={r.claimId}>
                <span className="range">{r.batchId}</span>
                <span className="syms">
                  {r.claimId.slice(0, 12)}… · encrypted: {r.inEncryptedPool ? "yes" : "no"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {researchOptedIn ? (
          <>
            <p className="inline-confirmation" role="status">You are opted in. New saved cycles are contributed anonymously to the current batch.</p>
            <button type="button" className="btn secondary" onClick={onOptOut}>Opt out of future contributions</button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn accent"
              disabled={pending || entries.length === 0 || !ageBand}
              onClick={() => onContribute()}
            >
              {pending ? "Opting in…" : latestEntryAlreadyContributed ? "Continue contributing automatically" : "Opt in and share latest summary"}
            </button>
            {latestEntryAlreadyContributed && (
              <p className="contribution-note" role="status">Your latest cycle is already in the pool. Turning this on means future saved cycles will contribute automatically.</p>
            )}
          </>
        )}
        {showRewards && (
          <ContributorRewardWallet
            contributionCount={receipts.length}
            rewardBatchId={receipts[0]?.batchId ?? null}
            latestClaimId={receipts[0]?.claimId ?? null}
          />
        )}
      </section>



      {status && <p className="banner ok" role="status">{status}</p>}
      {poolSummary && <p className="banner ok" role="status">{poolSummary}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}
    </div>
  )
}
