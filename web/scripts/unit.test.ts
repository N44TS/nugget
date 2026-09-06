import { describe, expect, test } from "bun:test"
import { aggregateContributions } from "../src/lib/aggregate"
import { wrapEncryptedBatch, xorDecryptUtf8 } from "../src/lib/crypto"

describe("real-only aggregate", () => {
  test("two 35-44 users → n=2 and only that age band", () => {
    const report = aggregateContributions(
      {
        epoch: "2026-W36",
        contributions: [
          {
            claimId: "a",
            cycleLengthDays: 28,
            periodLengthDays: 5,
            symptoms: ["cramps"],
            ageBand: "35-44",
          },
          {
            claimId: "b",
            cycleLengthDays: 30,
            periodLengthDays: 4,
            symptoms: ["mood"],
            ageBand: "35-44",
          },
        ],
      },
      1,
    )
    expect(report.contributorCount).toBe(2)
    expect(report.ageBandShare).toEqual({ "35-44": 1 })
    expect(report.avgCycleByAgeBand?.["35-44"]).toBe(29)
    expect(report.ageBandShare?.["25-34"]).toBeUndefined()
  })

  test("encrypt round-trip", () => {
    const secret = "nugget-phase0-sim-token"
    const batch = { epoch: "x", contributions: [] }
    const w = wrapEncryptedBatch(JSON.stringify(batch), secret)
    expect(JSON.parse(xorDecryptUtf8(Buffer.from(w.payload, "base64"), secret)).epoch).toBe("x")
  })
})
