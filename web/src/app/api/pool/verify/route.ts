import { NextResponse } from "next/server"
import { loadEncryptedPool, poolDataDir } from "@/lib/server-batch"
import { payoutWindowId } from "@/lib/cycle"

const K_MIN = 2

export async function GET() {
  const batch = await loadEncryptedPool()
  if (!batch || batch.contributions.length === 0) {
    return NextResponse.json({ ok: false, error: "empty pool", dataDir: poolDataDir() }, { status: 404 })
  }

  return NextResponse.json({
    ok: true,
    dataDir: poolDataDir(),
    pool: {
      batchId: payoutWindowId(),
      size: batch.contributions.length,
      kAnonOk: batch.contributions.length >= K_MIN,
      aggregates: null,
    },
  })
}
