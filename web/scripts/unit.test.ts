import { describe, expect, test } from "bun:test"
import { aggregateContributions } from "../src/lib/aggregate"
import {
  encryptForCre,
  decryptAuthenticatedUtf8,
  encryptAuthenticatedUtf8,
  wrapEncryptedBatch,
  xorDecryptUtf8,
} from "../src/lib/crypto"
import { x25519 } from "@noble/curves/ed25519.js"
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { sha256 } from "@noble/hashes/sha2.js"

describe("real-only aggregate", () => {
  test("one user is suppressed until a second user contributes", () => {
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
        ],
      },
      2,
    )

    expect(report.contributorCount).toBe(1)
    expect(report.kAnonOk).toBe(false)
    expect(report.avgCycleLength).toBeNull()
    expect(report.symptomRates).toBeNull()
  })

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
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const payload = encryptAuthenticatedUtf8(JSON.stringify(batch), secret, nonce)
    expect(JSON.parse(decryptAuthenticatedUtf8(payload, secret, nonce)).epoch).toBe("x")
  })

  test("authenticated encryption rejects tampered ciphertext", () => {
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const payload = encryptAuthenticatedUtf8("sensitive", "secret", nonce)
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`

    expect(() => decryptAuthenticatedUtf8(tampered, "secret", nonce)).toThrow()
  })

  test("encrypted batch wrapper carries a matching nonce", () => {
    const wrapper = wrapEncryptedBatch(JSON.stringify({ epoch: "x", contributions: [] }), "secret")
    expect(wrapper.encoding).toBe("nugget1-xchacha20poly1305-b64")
    expect(wrapper.nonce).toHaveLength(32)
  })

  test("browser envelope can be decrypted with the CRE recipient key", () => {
    const recipientPrivateKey = new Uint8Array(32).fill(7)
    const recipientPublicKey = x25519.getPublicKey(recipientPrivateKey)
    const ephemeralPrivateKey = new Uint8Array(32).fill(9)
    const envelope = encryptForCre("private contribution", recipientPublicKey, ephemeralPrivateKey)
    const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublicKey(envelope))
    const nonce = Uint8Array.from(atob(envelope.nonce), (char) => char.charCodeAt(0))
    const payload = Uint8Array.from(atob(envelope.payload), (char) => char.charCodeAt(0))

    expect(
      new TextDecoder().decode(xchacha20poly1305(sha256(sharedSecret), nonce).decrypt(payload)),
    ).toBe("private contribution")
  })
})

const ephemeralPublicKey = (envelope: { ephemeralPublicKey: string }): Uint8Array =>
  Uint8Array.from(atob(envelope.ephemeralPublicKey), (char) => char.charCodeAt(0))
