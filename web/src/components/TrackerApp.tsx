"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { entryToContribution, newClaimId } from "@/lib/cycle"
import { base64ToBytes, encryptForCre } from "@/lib/crypto"
import { loadEntries, loadReceipts, saveEntries, saveLocalReceipt, type LocalReceipt } from "@/lib/storage"
import {
  AGE_BAND_OPTIONS,
  SYMPTOM_OPTIONS,
  type AgeBand,
  type CycleEntry,
  type Symptom,
} from "@/lib/types"

const today = () => new Date().toISOString().slice(0, 10)
const AGE_KEY = "nugget.profile.ageBand.v1"

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

export function TrackerApp() {
  const [entries, setEntries] = useState<CycleEntry[]>([])
  const [receipts, setReceipts] = useState<LocalReceipt[]>([])
  const [ageBand, setAgeBand] = useState<AgeBand | "">("")
  const [periodStart, setPeriodStart] = useState(today())
  const [periodEnd, setPeriodEnd] = useState(today())
  const [symptoms, setSymptoms] = useState<Symptom[]>(["cramps"])
  const [status, setStatus] = useState<string | null>(null)
  const [poolSummary, setPoolSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setEntries(loadEntries())
    setReceipts(loadReceipts())
    const saved = localStorage.getItem(AGE_KEY) as AgeBand | null
    if (saved) setAgeBand(saved)
    setReady(true)
  }, [])

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.periodStart.localeCompare(a.periodStart)),
    [entries],
  )

  const toggleSymptom = (id: Symptom) => {
    setSymptoms((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
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
    const entry: CycleEntry = {
      id: crypto.randomUUID(),
      periodStart,
      periodEnd,
      symptoms,
      createdAt: new Date().toISOString(),
    }
    persist([entry, ...entries])
    setStatus("Saved on this device only (encrypted). Nothing uploaded.")
  }

  const onContribute = () => {
    setError(null)
    setStatus(null)
    setPoolSummary(null)
    if (!ageBand) {
      setError("Select an age band before opting in. (Band only — not your date of birth.)")
      return
    }
    startTransition(async () => {
      localStorage.setItem(AGE_KEY, ageBand)
      const contribution = entryToContribution(entries, newClaimId(), ageBand)
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
          body: JSON.stringify({ contribution: encryptedContribution }),
        })
        const data = (await res.json()) as ContributeResponse
        if (!res.ok || !data.ok || !data.receipt || !data.pool) {
          setError(data.error ?? "Contribute failed")
          return
        }

        setReceipts(saveLocalReceipt(data.receipt))
        setStatus(
          `Opt-in saved. Pool size now ${data.pool?.size ?? "?"} (shared folder). ` +
            `claimId ${data.receipt.claimId.slice(0, 12)}… — then open Buyer → Run CRE.`,
        )
        if (data.pool?.size) {
          setPoolSummary(`Shared pool has ${data.pool.size} real contribution(s). dataDir: ${data.dataDir ?? "?"}`)
        }
      } catch {
        setError("Network error while contributing.")
      }
    })
  }

  if (!ready) {
    return <p className="muted">Loading your private vault…</p>
  }

  return (
    <div className="stack">
      <p className="lede">
        <Link href="/buyer">Buyer console →</Link> (aggregate real opt-ins)
        <br />
        Tip: run <code>:3000</code> and <code>:3001</code> as two users — they share one pool. Avoid{" "}
        <code>basic-flow</code> (removed).
      </p>

      <section className="panel" aria-labelledby="profile-heading">
        <h2 id="profile-heading">About you (non-identifying)</h2>
        <p className="lede">Age band only — used in anonymous aggregates. Not your birthday or name.</p>
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

      <section className="panel" aria-labelledby="log-heading">
        <h2 id="log-heading">Log a period</h2>
        <p className="lede">Encrypted on this device. Not uploaded until you opt in.</p>

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

        <fieldset>
          <legend>Symptoms</legend>
          <div className="chips">
            {SYMPTOM_OPTIONS.map((opt) => {
              const on = symptoms.includes(opt.id)
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={on ? "chip on" : "chip"}
                  aria-pressed={on}
                  onClick={() => toggleSymptom(opt.id)}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </fieldset>

        <button type="button" className="btn primary" onClick={onSave}>
          Save entry
        </button>
      </section>

      <section className="panel" aria-labelledby="optin-heading">
        <h2 id="optin-heading">Opt in to research pool</h2>
        <p className="lede">
          Uploads an anonymous summary (cycle length, period length, symptoms, age band) into the
          encrypted pool. No money yet.
        </p>
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
        <button
          type="button"
          className="btn accent"
          disabled={pending || entries.length === 0 || !ageBand}
          onClick={onContribute}
        >
          {pending ? "Opting in…" : "Opt in"}
        </button>
      </section>

      <section className="panel" aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        {sorted.length === 0 ? (
          <p className="muted">No entries yet.</p>
        ) : (
          <ul className="history">
            {sorted.map((e) => (
              <li key={e.id}>
                <span className="range">
                  {e.periodStart} → {e.periodEnd}
                </span>
                <span className="syms">{e.symptoms.join(", ") || "no symptoms"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {status && <p className="banner ok" role="status">{status}</p>}
      {poolSummary && <p className="banner ok" role="status">{poolSummary}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}
    </div>
  )
}
