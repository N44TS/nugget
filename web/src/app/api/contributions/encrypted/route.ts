import { NextResponse } from "next/server"
import { loadEncryptedBatch, loadPool, poolDataDir } from "@/lib/server-batch"

/** CRE fetches this — ciphertext built from shared pool.json */
export async function GET() {
  const pool = await loadPool()
  if (!pool || pool.contributions.length === 0) {
    return NextResponse.json(
      { error: "empty pool", dataDir: poolDataDir() },
      { status: 404 },
    )
  }

  const wrapper = await loadEncryptedBatch()
  if (!wrapper) {
    return NextResponse.json({ error: "encrypt failed", dataDir: poolDataDir() }, { status: 500 })
  }

  return NextResponse.json(wrapper, {
    headers: { "Cache-Control": "no-store", "X-Nugget-Pool-Size": String(pool.contributions.length) },
  })
}
