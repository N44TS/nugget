import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatHex, encodePacked, getAddress, keccak256, type Hex } from 'viem'

/**
 * Nugget — aggregation inside the CRE TEE handler.
 * Raw rows stay in the enclave; only AggregateReport fields leave.
 */

export type AgeBand = '18-24' | '25-34' | '35-44' | '45+'

export type WellbeingSignals = {
	energy: 'low' | 'okay' | 'good'
	mood: 'low' | 'okay' | 'good'
	sleep: 'poor' | 'okay' | 'good'
	skin: 'flare-up' | 'normal' | 'clear'
	bleeding: 'none' | 'spotting' | 'light' | 'medium' | 'heavy'
	pain: 'none' | 'mild' | 'moderate' | 'strong' | 'severe'
}

export type Contribution = {
	claimId: string
	cycleLengthDays: number
	periodLengthDays: number
	symptoms: string[]
	ageBand: AgeBand
	wellbeing?: WellbeingSignals
	payoutWindowId?: string
	submittedAt?: string
}

export type ContributionBatch = {
	epoch: string
	contributions: Contribution[]
}

export type RewardRegistration = {
	claimId: string
	walletAddress: string
}

export type CreEncryptedContribution = {
	encoding: 'nugget1-x25519-xchacha20poly1305-b64'
	ephemeralPublicKey: string
	nonce: string
	payload: string
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
	ageBandStats: Record<string, SegmentStats> | null
	cycleLengthStats: Record<string, SegmentStats> | null
	moderateSeverePainRate: number | null
	/** Signal category shares, calculated only from contributions that supplied that signal. */
	wellbeingDistributions: Record<string, Record<string, number>> | null
	/** Observed joint shares, never labelled as relative risk or causation. */
	coOccurrenceRates: Record<string, number> | null
	rewardMerkleRoot: string | null
	eligibleWalletCount: number
	rewardProofs: Record<string, Hex[]>
}

export type SegmentStats = {
	count: number
	share: number
	avgCycle: number
	avgPeriod: number
	moderateSeverePain: number | null
	irregularCycle: number
	wellbeingCount: number
	moderateSeverePainCount: number
	heavyBleeding: number | null
	poorSleep: number | null
	skinFlare: number | null
}

const rewardLeaf = (wallet: string): Hex => keccak256(encodePacked(['address'], [getAddress(wallet)]))
const hashPair = (a: Hex, b: Hex): Hex => keccak256(concatHex(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]))

export const rewardMerkleRoot = (wallets: string[]): Hex | null => {
	let level = [...new Set(wallets.map(rewardLeaf))].sort()
	if (level.length === 0) return null
	while (level.length > 1) {
		const next: Hex[] = []
		for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i]!, level[i + 1] ?? level[i]!))
		level = next
	}
	return level[0]!
}

/** Proofs are derived alongside the root inside the TEE, never from a second server-side guest list. */
export const rewardProofs = (wallets: string[]): Record<string, Hex[]> => {
	const leaves = [...new Set(wallets.map((wallet) => rewardLeaf(wallet)))].sort()
	const leafToWallet = new Map(wallets.map((wallet) => [rewardLeaf(wallet).toLowerCase(), getAddress(wallet)]))
	const proofs: Record<string, Hex[]> = {}
	for (let target = 0; target < leaves.length; target += 1) {
		let index = target
		let level = [...leaves]
		const proof: Hex[] = []
		while (level.length > 1) {
			const sibling = index % 2 === 0 ? level[index + 1] ?? level[index] : level[index - 1]
			proof.push(sibling!)
			const next: Hex[] = []
			for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i]!, level[i + 1] ?? level[i]!))
			index = Math.floor(index / 2)
			level = next
		}
		const wallet = leafToWallet.get(leaves[target]!.toLowerCase())
		if (wallet) proofs[wallet.toLowerCase()] = proof
	}
	return proofs
}

const CYCLE_MIN = 15
const CYCLE_MAX = 90
const PERIOD_MIN = 1
const PERIOD_MAX = 15

const isValidWellbeing = (signals: WellbeingSignals): boolean =>
	['low', 'okay', 'good'].includes(signals.energy) &&
	['low', 'okay', 'good'].includes(signals.mood) &&
	['poor', 'okay', 'good'].includes(signals.sleep) &&
	['flare-up', 'normal', 'clear'].includes(signals.skin) &&
	['none', 'spotting', 'light', 'medium', 'heavy'].includes(signals.bleeding) &&
	['none', 'mild', 'moderate', 'strong', 'severe'].includes(signals.pain)

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
	if (c.wellbeing && !isValidWellbeing(c.wellbeing)) return false
	return true
}

const keyBytes = (key: string): Uint8Array => sha256(new TextEncoder().encode(key))
const sharedKey = (sharedSecret: Uint8Array): Uint8Array => sha256(sharedSecret)

export const encryptAuthenticatedUtf8 = (
	plain: string,
	key: string,
	nonce: Uint8Array,
): Uint8Array => xchacha20poly1305(keyBytes(key), nonce).encrypt(new TextEncoder().encode(plain))

export const decryptAuthenticatedUtf8 = (
	cipherBytes: Uint8Array,
	key: string,
	nonce: Uint8Array,
): string => new TextDecoder().decode(xchacha20poly1305(keyBytes(key), nonce).decrypt(cipherBytes))

export const decryptForCre = (
	envelope: CreEncryptedContribution,
	recipientPrivateKey: Uint8Array,
	base64ToBytes: (value: string) => Uint8Array,
): string => {
	const sharedSecret = x25519.getSharedSecret(
		recipientPrivateKey,
		base64ToBytes(envelope.ephemeralPublicKey),
	)
	return new TextDecoder().decode(
		xchacha20poly1305(sharedKey(sharedSecret), base64ToBytes(envelope.nonce)).decrypt(
			base64ToBytes(envelope.payload),
		),
	)
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
	rewardRegistrations: RewardRegistration[] = [],
	rewardWindowId?: string,
	reportSince?: string,
): AggregateReport => {
	const valid = batch.contributions.filter((contribution) => {
		if (!isValidContribution(contribution)) return false
		// New contributions carry this encrypted timestamp. Old demo rows without
		// one remain readable rather than silently disappearing during migration.
		return !reportSince || !contribution.submittedAt || contribution.submittedAt >= reportSince
	})
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
			ageBandStats: null,
			cycleLengthStats: null,
			moderateSeverePainRate: null,
			wellbeingDistributions: null,
			coOccurrenceRates: null,
			rewardMerkleRoot: null,
			eligibleWalletCount: 0,
			rewardProofs: {},
		}
	}

	// Only a registration whose claimId belongs to a valid decrypted contribution can earn.
	const validClaims = new Set(
		valid
			.filter((contribution) => !rewardWindowId || contribution.payoutWindowId === rewardWindowId)
			.map((contribution) => contribution.claimId),
	)
	const eligibleWallets = rewardRegistrations
		.filter((registration) => validClaims.has(registration.claimId) && /^0x[a-fA-F0-9]{40}$/.test(registration.walletAddress))
		.map((registration) => registration.walletAddress)
	const uniqueEligibleWallets = [...new Set(eligibleWallets.map((wallet) => wallet.toLowerCase()))]

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
	for (const [symptom, count] of Object.entries(symptomCounts).sort(([a], [b]) => a.localeCompare(b))) {
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
	const segmentStats = (rows: Contribution[]): SegmentStats => {
		const wellbeingRows = rows.filter((row) => row.wellbeing)
		const painRows = wellbeingRows.filter((row) =>
			['moderate', 'strong', 'severe'].includes(row.wellbeing?.pain ?? ''),
		)
		const heavyBleedingRows = wellbeingRows.filter((row) => row.wellbeing?.bleeding === 'heavy')
		const poorSleepRows = wellbeingRows.filter((row) => row.wellbeing?.sleep === 'poor')
		const skinFlareRows = wellbeingRows.filter((row) => row.wellbeing?.skin === 'flare-up')
		return {
			count: rows.length,
			share: round1(rows.length / contributorCount),
			avgCycle: round1(rows.reduce((sum, row) => sum + row.cycleLengthDays, 0) / rows.length),
			avgPeriod: round1(rows.reduce((sum, row) => sum + row.periodLengthDays, 0) / rows.length),
			moderateSeverePain:
				wellbeingRows.length >= kMin && painRows.length >= kMin ? round1(painRows.length / wellbeingRows.length) : null,
			irregularCycle: round1(rows.filter((row) => row.cycleLengthDays > 35).length / rows.length),
			wellbeingCount: wellbeingRows.length,
			moderateSeverePainCount: painRows.length,
			heavyBleeding:
				wellbeingRows.length >= kMin && heavyBleedingRows.length >= kMin ? round1(heavyBleedingRows.length / wellbeingRows.length) : null,
			poorSleep:
				wellbeingRows.length >= kMin && poorSleepRows.length >= kMin ? round1(poorSleepRows.length / wellbeingRows.length) : null,
			skinFlare:
				wellbeingRows.length >= kMin && skinFlareRows.length >= kMin ? round1(skinFlareRows.length / wellbeingRows.length) : null,
		}
	}
	const ageBandStats: Record<string, SegmentStats> = {}
	for (const [band, count] of Object.entries(bandCounts).sort(([a], [b]) => a.localeCompare(b))) {
		if (count >= kMin) {
			ageBandShare[band] = round1(count / contributorCount)
			avgCycleByAgeBand[band] = round1((bandCycleSum[band] ?? 0) / count)
			ageBandStats[band] = segmentStats(valid.filter((row) => row.ageBand === band))
		}
	}
	const cycleLengthStats: Record<string, SegmentStats> = {}
	const cycleBuckets: Record<string, (row: Contribution) => boolean> = {
		short: (row) => row.cycleLengthDays < 25,
		typical: (row) => row.cycleLengthDays >= 25 && row.cycleLengthDays <= 35,
		long: (row) => row.cycleLengthDays > 35,
	}
	for (const [bucket, matches] of Object.entries(cycleBuckets).sort(([a], [b]) => a.localeCompare(b))) {
		const rows = valid.filter(matches)
		if (rows.length >= kMin) cycleLengthStats[bucket] = segmentStats(rows)
	}

	const wellbeingDistributions: Record<string, Record<string, number>> = {}
	const wellbeingRows = valid.filter((contribution) => contribution.wellbeing)
	const moderateSeverePainRows = wellbeingRows.filter((contribution) =>
		['moderate', 'strong', 'severe'].includes(contribution.wellbeing?.pain ?? ''),
	)
	const moderateSeverePainRate =
		wellbeingRows.length >= kMin && moderateSeverePainRows.length >= kMin
			? round1(moderateSeverePainRows.length / wellbeingRows.length)
			: null
	const wellbeingFields = ['energy', 'mood', 'sleep', 'skin', 'bleeding', 'pain'] as const
	for (const field of wellbeingFields) {
		const rows = valid.filter((contribution) => contribution.wellbeing?.[field] !== undefined)
		if (rows.length < kMin) continue
		const counts: Record<string, number> = {}
		for (const row of rows) {
			const value = row.wellbeing?.[field]
			if (value) counts[value] = (counts[value] ?? 0) + 1
		}
		const disclosed = Object.entries(counts)
			.filter(([, count]) => count >= kMin)
			.sort(([a], [b]) => a.localeCompare(b))
		if (disclosed.length) {
			wellbeingDistributions[field] = Object.fromEntries(
				disclosed.map(([value, count]) => [value, round1(count / rows.length)]),
			)
		}
	}

	const coOccurrenceDefinitions: Record<string, (contribution: Contribution) => boolean> = {
		sleepGood_skinClear: (c) => c.wellbeing?.sleep === 'good' && c.wellbeing?.skin === 'clear',
		bleedingHeavy_painModerateOrWorse: (c) =>
			c.wellbeing?.bleeding === 'heavy' &&
			['moderate', 'strong', 'severe'].includes(c.wellbeing.pain),
		skinFlare_moodLow: (c) => c.wellbeing?.skin === 'flare-up' && c.wellbeing?.mood === 'low',
		painModerateOrWorse_skinFlare: (c) =>
			['moderate', 'strong', 'severe'].includes(c.wellbeing?.pain ?? '') &&
			c.wellbeing?.skin === 'flare-up',
	}
	const coOccurrenceRates: Record<string, number> = {}
	for (const [name, matches] of Object.entries(coOccurrenceDefinitions).sort(([a], [b]) => a.localeCompare(b))) {
		const rows = valid.filter((contribution) => contribution.wellbeing)
		const matching = rows.filter(matches).length
		if (rows.length >= kMin && matching >= kMin) {
			coOccurrenceRates[name] = round1(matching / rows.length)
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
		ageBandShare: Object.keys(ageBandShare).sort().length ? ageBandShare : null,
		avgCycleByAgeBand: Object.keys(avgCycleByAgeBand).sort().length ? avgCycleByAgeBand : null,
		ageBandStats: Object.keys(ageBandStats).sort().length ? ageBandStats : null,
		cycleLengthStats: Object.keys(cycleLengthStats).sort().length ? cycleLengthStats : null,
		moderateSeverePainRate,
		wellbeingDistributions: Object.keys(wellbeingDistributions).sort().length ? wellbeingDistributions : null,
		coOccurrenceRates: Object.keys(coOccurrenceRates).sort().length ? coOccurrenceRates : null,
		rewardMerkleRoot: rewardMerkleRoot(uniqueEligibleWallets),
		eligibleWalletCount: uniqueEligibleWallets.length,
		rewardProofs: rewardProofs(uniqueEligibleWallets),
	}
}

export const formatPublicSummary = (report: AggregateReport): string => {
	if (!report.kAnonOk) {
		return `SUPPRESSED batch=${report.epoch} n=${report.contributorCount} kMin=${report.kMin}`
	}
	const symptoms = report.symptomRates
		? Object.entries(report.symptomRates).sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${k}:${v}`)
				.join(',')
		: ''
	const ages = report.ageBandShare
		? Object.entries(report.ageBandShare).sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${k}:${v}`)
				.join(',')
		: ''
	const avgByAge = report.avgCycleByAgeBand
		? Object.entries(report.avgCycleByAgeBand).sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${k}:${v}`)
				.join(',')
		: ''
	const encodeSegments = (segments: Record<string, SegmentStats> | null): string =>
		segments
			? Object.entries(segments)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, stats]) =>
						`${key}:${stats.count}|${stats.share}|${stats.avgCycle}|${stats.avgPeriod}|${stats.moderateSeverePain ?? 'x'}|${stats.irregularCycle}|${stats.wellbeingCount}|${stats.moderateSeverePainCount}|${stats.heavyBleeding ?? 'x'}|${stats.poorSleep ?? 'x'}|${stats.skinFlare ?? 'x'}`,
					)
					.join(',')
			: ''
	const wellbeing = report.wellbeingDistributions
		? Object.entries(report.wellbeingDistributions)
				.sort(([a], [b]) => a.localeCompare(b))
				.flatMap(([field, values]) =>
					Object.entries(values)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([value, rate]) => `${field}.${value}:${rate}`),
				)
				.join(',')
		: ''
	const coOccurrence = report.coOccurrenceRates
		? Object.entries(report.coOccurrenceRates)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => `${key}:${value}`)
				.join(',')
		: ''
	return `OK batch=${report.epoch} n=${report.contributorCount} avgCycle=${report.avgCycleLength} avgPeriod=${report.avgPeriodLength} symptoms={${symptoms}} ageShare={${ages}} avgCycleByAge={${avgByAge}} rejected=${report.rejectedCount} rewardRoot=${report.rewardMerkleRoot ?? 'none'} eligibleWallets=${report.eligibleWalletCount} wellbeing={${wellbeing}} coOccurrence={${coOccurrence}} ageStats={${encodeSegments(report.ageBandStats)}} cycleStats={${encodeSegments(report.cycleLengthStats)}} painRate=${report.moderateSeverePainRate ?? 'x'}`
}
