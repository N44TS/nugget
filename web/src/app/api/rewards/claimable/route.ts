import { NextResponse } from "next/server"
import { listRewardClaimBatches } from "@/lib/server-batch"

export async function GET(request: Request) {
  const walletAddress = new URL(request.url).searchParams.get("walletAddress")
  if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json({ error: "A valid walletAddress is required" }, { status: 400 })
  }
  return NextResponse.json({ ok: true, batchIds: await listRewardClaimBatches(walletAddress) })
}