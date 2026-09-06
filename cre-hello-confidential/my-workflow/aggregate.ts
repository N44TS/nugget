/**
 * Nugget — aggregation inside the CRE TEE handler.
 * Raw rows stay in the enclave; only AggregateReport fields leave.
 */

export type AgeBand = '18-24' | '25-34' | '35-44' | '45+'

export type Contribution = {
	claimId: string
	cycleLengthDays: number
	periodLengthDays: number
	symptoms: string[]
	ageBand: AgeBand
}

export type ContributionBatch = {
	epoch: string
	contributions: Contribution[]
}

export type AggregateReport = {
	epoch: string
	contributorCount: number
	validCount: number
	rejectedCount: number
	kMin: number
	kAnonOk: boolean
	avgCycleLength: number | null
	avgPeriodLength: number | null
	symptomRates: Record<string, number> | null
	ageBandShare: Record<string, number> | null
	avgCycleByAgeBand: Record<string, number> | null
}

const CYCLE_MIN = 15
const CYCLE_MAX = 90
const PERIOD_MIN = 1
const PERIOD_MAX = 15

export const isValidContribution = (c: Contribution): boolean => {
	if (!c.claimId || typeof c.claimId !== 'string') return false
	if (!c.ageBand) return false
	if (!Number.isFinite(c.cycleLengthDays) || c.cycleLengthDays < CYCLE_MIN || c.cycleLengthDays > CYCLE_MAX) {
		return false
	}
	if (
		!Number.isFinite(c.periodLengthDays) ||
		c.periodLengthDays < PERIOD_MIN ||
		c.periodLengthDays > PERIOD_MAX
	) {
		return false
	}
	if (!Array.isArray(c.symptoms)) return false
	return true
}

export const xorDecryptUtf8 = (cipherBytes: Uint8Array, key: string): string => {
	if (!key) throw new Error('decrypt key is empty')
	const out = new Uint8Array(cipherBytes.length)
	for (let i = 0; i < cipherBytes.length; i++) {
		out[i] = cipherBytes[i]! ^ key.charCodeAt(i % key.length)
	}
	return new TextDecoder().decode(out)
}

export const xorEncryptUtf8 = (plain: string, key: string): Uint8Array => {
	const bytes = new TextEncoder().encode(plain)
	const out = new Uint8Array(bytes.length)
	for (let i = 0; i < bytes.length; i++) {
		out[i] = bytes[i]! ^ key.charCodeAt(i % key.length)
	}
	return out
}

export const parseContributionBatch = (raw: unknown): ContributionBatch => {
	if (!raw || typeof raw !== 'object') throw new Error('batch must be an object')
	const obj = raw as Record<string, unknown>
	if (typeof obj.epoch !== 'string' || !obj.epoch) throw new Error('batch.epoch required')
	if (!Array.isArray(obj.contributions)) throw new Error('batch.contributions must be an array')
	return {
		epoch: obj.epoch,
		contributions: obj.contributions as Contribution[],
	}
}

const round1 = (n: number): number => Math.round(n * 10) / 10

export const aggregateContributions = (
	batch: ContributionBatch,
	kMin: number,
): AggregateReport => {
	const valid = batch.contributions.filter(isValidContribution)
	const rejectedCount = batch.contributions.length - valid.length
	const contributorCount = valid.length
	const kAnonOk = contributorCount >= kMin

	if (!kAnonOk) {
		return {
			epoch: batch.epoch,
			contributorCount,
			validCount: contributorCount,
			rejectedCount,
			kMin,
			kAnonOk: false,
			avgCycleLength: null,
			avgPeriodLength: null,
			symptomRates: null,
			ageBandShare: null,
			avgCycleByAgeBand: null,
		}
	}

	const avgCycleLength = round1(
		valid.reduce((sum, c) => sum + c.cycleLengthDays, 0) / contributorCount,
	)
	const avgPeriodLength = round1(
		valid.reduce((sum, c) => sum + c.periodLengthDays, 0) / contributorCount,
	)

	const symptomCounts: Record<string, number> = {}
	for (const c of valid) {
		const unique = new Set(c.symptoms.map((s) => s.toLowerCase()))
		for (const s of unique) {
			symptomCounts[s] = (symptomCounts[s] ?? 0) + 1
		}
	}
	const symptomRates: Record<string, number> = {}
	for (const [symptom, count] of Object.entries(symptomCounts)) {
		if (count >= kMin) symptomRates[symptom] = round1(count / contributorCount)
	}

	const bandCounts: Record<string, number> = {}
	const bandCycleSum: Record<string, number> = {}
	for (const c of valid) {
		bandCounts[c.ageBand] = (bandCounts[c.ageBand] ?? 0) + 1
		bandCycleSum[c.ageBand] = (bandCycleSum[c.ageBand] ?? 0) + c.cycleLengthDays
	}

	const ageBandShare: Record<string, number> = {}
	const avgCycleByAgeBand: Record<string, number> = {}
	for (const [band, count] of Object.entries(bandCounts)) {
		if (count >= kMin) {
			ageBandShare[band] = round1(count / contributorCount)
			avgCycleByAgeBand[band] = round1((bandCycleSum[band] ?? 0) / count)
		}
	}

	return {
		epoch: batch.epoch,
		contributorCount,
		validCount: contributorCount,
		rejectedCount,
		kMin,
		kAnonOk: true,
		avgCycleLength,
		avgPeriodLength,
		symptomRates,
		ageBandShare: Object.keys(ageBandShare).length ? ageBandShare : null,
		avgCycleByAgeBand: Object.keys(avgCycleByAgeBand).length ? avgCycleByAgeBand : null,
	}
}

export const formatPublicSummary = (report: AggregateReport): string => {
	if (!report.kAnonOk) {
		return `SUPPRESSED batch=${report.epoch} n=${report.contributorCount} kMin=${report.kMin}`
	}
	const symptoms = report.symptomRates
		? Object.entries(report.symptomRates)
				.map(([k, v]) => `${k}:${v}`)
				.join(',')
		: ''
	const ages = report.ageBandShare
		? Object.entries(report.ageBandShare)
				.map(([k, v]) => `${k}:${v}`)
				.join(',')
		: ''
	const avgByAge = report.avgCycleByAgeBand
		? Object.entries(report.avgCycleByAgeBand)
				.map(([k, v]) => `${k}:${v}`)
				.join(',')
		: ''
	return `OK batch=${report.epoch} n=${report.contributorCount} avgCycle=${report.avgCycleLength} avgPeriod=${report.avgPeriodLength} symptoms={${symptoms}} ageShare={${ages}} avgCycleByAge={${avgByAge}} rejected=${report.rejectedCount}`
}
