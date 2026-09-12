import { NextResponse } from "next/server"
import { listBuyerPayments } from "@/lib/server-batch"

export async function GET(request: Request) {
  const buyerAddress = new URL(request.url).searchParams.get("buyerAddress")
  if (!buyerAddress || !/^0x[a-fA-F0-9]{40}$/.test(buyerAddress)) {
    return NextResponse.json({ ok: false, error: "A valid buyer wallet address is required" }, { status: 400 })
  }

  const reports = await listBuyerPayments(buyerAddress)
  return NextResponse.json({ ok: true, reports })
}
