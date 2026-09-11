import { NextResponse } from "next/server"
import { addEncryptedRewardRegistration } from "@/lib/server-batch"
import type { CreEncryptedContribution } from "@/lib/crypto"

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 })
  }

  const parsed = body as {
    walletAddress?: unknown
    claimId?: unknown
    batchId?: unknown
    registration?: CreEncryptedContribution
  }
  const { walletAddress, claimId, registration } = parsed
  if (typeof walletAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json({ ok: false, error: "valid Ethereum wallet address required" }, { status: 400 })
  }

  const batchId = typeof parsed.batchId === "string" ? parsed.batchId : ""
  if (!/^\d{4}-P\d{2}$/.test(batchId)) {
    return NextResponse.json({ error: "A valid payout window is required" }, { status: 400 })
  }
  if (
    typeof claimId !== "string" ||
    registration?.encoding !== "nugget1-x25519-xchacha20poly1305-b64" ||
    typeof registration.ephemeralPublicKey !== "string" ||
    typeof registration.nonce !== "string" ||
    typeof registration.payload !== "string"
  ) {
    return NextResponse.json({ ok: false, error: "encrypted reward registration and claim ID required" }, { status: 400 })
  }
  try {
    await addEncryptedRewardRegistration({
      batchId,
      envelope: registration,
    })
  } catch (error) {
    console.error("[rewards] opt-in persistence failed", error)
    return NextResponse.json({ ok: false, error: "Reward opt-in could not be saved" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, batchId, status: "eligible" })
}
