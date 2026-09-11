import { NextResponse } from "next/server"
import { payoutWindowId } from "@/lib/cycle"
import {
  addEncryptedContribution,
  poolDataDir,
  saveReceipt,
} from "@/lib/server-batch"
import type { CreEncryptedContribution } from "@/lib/crypto"

const K_MIN = 2
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }

  const contributionBody = body as { contribution?: CreEncryptedContribution; claimId?: string }
  const envelope = contributionBody.contribution
  if (
    envelope?.encoding !== "nugget1-x25519-xchacha20poly1305-b64" ||
    typeof envelope.ephemeralPublicKey !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.payload !== "string"
  ) {
    return NextResponse.json({ error: "encrypted contribution required" }, { status: 400 })
  }

  const batchId = payoutWindowId()
  const pool = await addEncryptedContribution(envelope, batchId)
  const receiptId = contributionBody.claimId
  if (!receiptId || !/^n[a-f0-9]{16}$/i.test(receiptId)) {
    return NextResponse.json({ error: "valid client claim ID required" }, { status: 400 })
  }

  await saveReceipt({
    claimId: receiptId,
    batchId,
    createdAt: new Date().toISOString(),
    inEncryptedPool: true,
  })

  return NextResponse.json({
    ok: true,
    dataDir: poolDataDir(),
    receipt: {
      claimId: receiptId,
      batchId,
      inEncryptedPool: true,
    },
    pool: {
      batchId: pool.epoch,
      size: pool.contributions.length,
      kMin: K_MIN,
      kAnonOk: pool.contributions.length >= K_MIN,
      realContributionsOnly: true,
    },
    cre: {
      ran: false,
      reason: "Opt-in saved to shared pool. Open /buyer → Run CRE aggregation.",
    },
  })
}
