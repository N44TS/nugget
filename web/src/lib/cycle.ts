import type { AgeBand, Contribution, CycleEntry } from "./types"

const dayMs = 24 * 60 * 60 * 1000

export const daysBetween = (start: string, end: string): number => {
  const a = new Date(`${start}T00:00:00Z`).getTime()
  const b = new Date(`${end}T00:00:00Z`).getTime()
  return Math.round((b - a) / dayMs) + 1
}

export const isoWeekEpoch = (d = new Date()): string => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / dayMs + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/**
 * A payout window is a fixed, UTC-aligned fourteen-day period. Data is kept
 * available for the rolling research report, but a wallet can only earn from
 * the window in which it contributed.
 */
export const payoutWindowId = (d = new Date()): string => {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const dayIndex = Math.floor((date.getTime() - yearStart) / dayMs)
  const period = Math.floor(dayIndex / 14) + 1
  return `${date.getUTCFullYear()}-P${String(period).padStart(2, "0")}`
}

/** Build an anonymous contribution from logged periods + declared age band. */
export const entryToContribution = (
  entries: CycleEntry[],
  claimId: string,
  ageBand: AgeBand,
  payoutWindow = payoutWindowId(),
): Contribution | null => {
  if (entries.length === 0) return null
  const sorted = [...entries].sort((a, b) => a.periodStart.localeCompare(b.periodStart))
  const latest = sorted[sorted.length - 1]!
  const periodLengthDays = daysBetween(latest.periodStart, latest.periodEnd)

  let cycleLengthDays = 28
  if (sorted.length >= 2) {
    const prev = sorted[sorted.length - 2]!
    cycleLengthDays = Math.round(
      (new Date(`${latest.periodStart}T00:00:00Z`).getTime() -
        new Date(`${prev.periodStart}T00:00:00Z`).getTime()) /
        dayMs,
    )
  }

  return {
    claimId,
    cycleLengthDays,
    periodLengthDays,
    symptoms: latest.symptoms,
    ageBand,
    payoutWindowId: payoutWindow,
    submittedAt: new Date().toISOString(),
  }
}

export const newClaimId = (): string => {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `n${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}
