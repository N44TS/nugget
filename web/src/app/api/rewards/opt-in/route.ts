import { NextResponse } from "next/server"
import { isoWeekEpoch } from "@/lib/cycle"
import { saveRewardOptIn } from "@/lib/server-batch"

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 })
  }

  const walletAddress = (body as { walletAddress?: unknown }).walletAddress
  if (typeof walletAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json({ ok: false, error: "valid Ethereum wallet address required" }, { status: 400 })
  }

  const batchId = isoWeekEpoch()
  try {
    await saveRewardOptIn({
      batchId,
      walletAddress: walletAddress.toLowerCase(),
      optedInAt: new Date().toISOString(),
      status: "eligible",
    })
  } catch (error) {
    console.error("[rewards] opt-in persistence failed", error)
    return NextResponse.json({ ok: false, error: "Reward opt-in could not be saved" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, batchId, status: "eligible" })
}
