import { NextResponse } from "next/server"
import { loadEncryptedBatch, poolDataDir } from "@/lib/server-batch"

/** CRE fetches this — ciphertext built from shared pool.json */
export async function GET() {
  const batch = await loadEncryptedBatch()
  if (!batch) {
    return NextResponse.json(
      { error: "empty pool", dataDir: poolDataDir() },
      { status: 404 },
    )
  }

  return NextResponse.json(batch, {
    headers: { "Cache-Control": "no-store", "X-Nugget-Pool-Size": String(batch.contributions.length) },
  })
}
