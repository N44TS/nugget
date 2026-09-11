import { NextResponse } from "next/server"
import { loadRewardClaimProof } from "@/lib/server-batch"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const batchId = searchParams.get("batchId")
  const walletAddress = searchParams.get("walletAddress")
  if (!batchId || !walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json({ error: "batchId and a valid walletAddress are required" }, { status: 400 })
  }
  const proof = await loadRewardClaimProof(batchId, walletAddress)
  if (!proof) {
    return NextResponse.json({
      error: "No reward is ready for this wallet in this payout window. A buyer must settle the window after your contribution and reward-wallet registration; registrations made afterwards become eligible for a future window.",
      code: "REWARD_NOT_READY_FOR_WINDOW",
    }, { status: 404 })
  }
  return NextResponse.json({ ok: true, proof })
}
