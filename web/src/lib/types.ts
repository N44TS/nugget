export type Symptom = "cramps" | "mood" | "headache" | "fatigue"

export type AgeBand = "18-24" | "25-34" | "35-44" | "45+"

export type CycleEntry = {
  id: string
  periodStart: string // YYYY-MM-DD
  periodEnd: string
  symptoms: Symptom[]
  createdAt: string
}

export type Contribution = {
  claimId: string
  cycleLengthDays: number
  periodLengthDays: number
  symptoms: string[]
  ageBand: AgeBand
  /** Present on new encrypted rows; optional so earlier local demo data stays readable. */
  payoutWindowId?: string
  submittedAt?: string
}

export type ContributionBatch = {
  epoch: string
  contributions: Contribution[]
}

export type EncryptedWrapper = {
  encoding: "nugget1-xchacha20poly1305-b64"
  nonce: string
  payload: string
}

export type EncryptedContributionBatch = {
  encoding: "nugget1-contribution-batch-v1"
  epoch: string
  contributions: CreEncryptedContribution[]
  rewardRegistrations?: CreEncryptedContribution[]
}

export const SYMPTOM_OPTIONS: { id: Symptom; label: string }[] = [
  { id: "cramps", label: "Cramps" },
  { id: "mood", label: "Mood" },
  { id: "headache", label: "Headache" },
  { id: "fatigue", label: "Fatigue" },
]

export const AGE_BAND_OPTIONS: { id: AgeBand; label: string }[] = [
  { id: "18-24", label: "18–24" },
  { id: "25-34", label: "25–34" },
  { id: "35-44", label: "35–44" },
  { id: "45+", label: "45+" },
]
import type { CreEncryptedContribution } from "./crypto"
