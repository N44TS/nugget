import type { Contribution } from "@/lib/types"

/** Demo seed rows so the pool can clear k-anonymity. Not real users. */
export const SEED_CONTRIBUTIONS: Contribution[] = [
  { claimId: "s01", cycleLengthDays: 28, periodLengthDays: 5, symptoms: ["cramps", "mood"], ageBand: "25-34" },
  { claimId: "s02", cycleLengthDays: 30, periodLengthDays: 4, symptoms: ["cramps"], ageBand: "25-34" },
  { claimId: "s03", cycleLengthDays: 26, periodLengthDays: 6, symptoms: ["headache", "mood"], ageBand: "18-24" },
  { claimId: "s04", cycleLengthDays: 32, periodLengthDays: 5, symptoms: ["cramps", "fatigue"], ageBand: "35-44" },
  { claimId: "s05", cycleLengthDays: 27, periodLengthDays: 4, symptoms: ["mood"], ageBand: "25-34" },
  { claimId: "s06", cycleLengthDays: 29, periodLengthDays: 5, symptoms: ["cramps", "headache"], ageBand: "18-24" },
  { claimId: "s07", cycleLengthDays: 31, periodLengthDays: 7, symptoms: ["fatigue"], ageBand: "35-44" },
  { claimId: "s08", cycleLengthDays: 25, periodLengthDays: 3, symptoms: ["cramps", "mood", "fatigue"], ageBand: "25-34" },
  { claimId: "s09", cycleLengthDays: 28, periodLengthDays: 5, symptoms: ["cramps"], ageBand: "45+" },
  { claimId: "s10", cycleLengthDays: 29, periodLengthDays: 5, symptoms: ["cramps", "mood"], ageBand: "25-34" },
  { claimId: "s11", cycleLengthDays: 27, periodLengthDays: 4, symptoms: ["mood"], ageBand: "18-24" },
  { claimId: "s12", cycleLengthDays: 30, periodLengthDays: 6, symptoms: ["cramps"], ageBand: "18-24" },
  { claimId: "s13", cycleLengthDays: 28, periodLengthDays: 5, symptoms: ["fatigue", "mood"], ageBand: "35-44" },
  { claimId: "s14", cycleLengthDays: 33, periodLengthDays: 5, symptoms: ["cramps"], ageBand: "35-44" },
  { claimId: "s15", cycleLengthDays: 26, periodLengthDays: 4, symptoms: ["headache"], ageBand: "18-24" },
]
