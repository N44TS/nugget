import { NextResponse } from "next/server"
import { clearPool } from "@/lib/server-batch"

/** Wipe encrypted pool + receipts so the next demo starts from zero real opt-ins. */
export async function POST() {
  await clearPool()
  return NextResponse.json({ ok: true, message: "pool cleared — no contributions" })
}
