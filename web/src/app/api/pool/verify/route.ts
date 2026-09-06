import { NextResponse } from "next/server"
import { aggregateContributions } from "@/lib/aggregate"
import { loadPool, poolDataDir } from "@/lib/server-batch"

const K_MIN = 1

export async function GET() {
  const batch = await loadPool()
  if (!batch || batch.contributions.length === 0) {
    return NextResponse.json({ ok: false, error: "empty pool", dataDir: poolDataDir() }, { status: 404 })
  }

  const report = aggregateContributions(batch, K_MIN)
  return NextResponse.json({
    ok: true,
    dataDir: poolDataDir(),
    pool: {
      batchId: report.epoch,
      size: batch.contributions.length,
      claimIds: batch.contributions.map((c) => c.claimId),
      kAnonOk: report.kAnonOk,
      aggregates: report.kAnonOk
        ? {
            avgCycleLength: report.avgCycleLength,
            avgPeriodLength: report.avgPeriodLength,
            symptomRates: report.symptomRates,
            ageBandShare: report.ageBandShare,
            avgCycleByAgeBand: report.avgCycleByAgeBand,
          }
        : null,
    },
  })
}
