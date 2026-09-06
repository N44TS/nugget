import { NextResponse } from "next/server"
import { aggregateContributions } from "@/lib/aggregate"
import { isoWeekEpoch } from "@/lib/cycle"
import {
  addContribution,
  loadPool,
  poolDataDir,
  saveReceipt,
} from "@/lib/server-batch"
import type { AgeBand, Contribution } from "@/lib/types"

const K_MIN = 1
const AGE_BANDS: AgeBand[] = ["18-24", "25-34", "35-44", "45+"]

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }

  const contribution = (body as { contribution?: Contribution }).contribution
  if (!contribution?.claimId || !Array.isArray(contribution.symptoms)) {
    return NextResponse.json({ error: "contribution required" }, { status: 400 })
  }
  if (!contribution.ageBand || !AGE_BANDS.includes(contribution.ageBand)) {
    return NextResponse.json({ error: "ageBand required" }, { status: 400 })
  }
  if (
    !Number.isFinite(contribution.cycleLengthDays) ||
    !Number.isFinite(contribution.periodLengthDays)
  ) {
    return NextResponse.json({ error: "invalid contribution numbers" }, { status: 400 })
  }

  const batchId = isoWeekEpoch()
  const pool = await addContribution(contribution, batchId)

  await saveReceipt({
    claimId: contribution.claimId,
    batchId,
    createdAt: new Date().toISOString(),
    inEncryptedPool: true,
  })

  const publicPool = aggregateContributions(pool, K_MIN)
  const verified = await loadPool()

  return NextResponse.json({
    ok: true,
    dataDir: poolDataDir(),
    receipt: {
      claimId: contribution.claimId,
      batchId,
      inEncryptedPool: true,
    },
    pool: {
      batchId: publicPool.epoch,
      size: verified?.contributions.length ?? publicPool.contributorCount,
      claimIds: (verified?.contributions ?? []).map((c) => c.claimId),
      kMin: publicPool.kMin,
      kAnonOk: publicPool.kAnonOk,
      realContributionsOnly: true,
    },
    cre: {
      ran: false,
      reason: "Opt-in saved to shared pool. Open /buyer → Run CRE aggregation.",
    },
  })
}
