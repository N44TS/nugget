import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatHex, encodePacked, getAddress, keccak256, type Hex } from 'viem'

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
	rewardMerkleRoot: string | null
	eligibleWalletCount: number
	rewardProofs: Record<string, Hex[]>
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
	for (const [band, count] of Object.entries(bandCounts).sort(([a], [b]) => a.localeCompare(b))) {
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
		ageBandShare: Object.keys(ageBandShare).sort().length ? ageBandShare : null,
		avgCycleByAgeBand: Object.keys(avgCycleByAgeBand).sort().length ? avgCycleByAgeBand : null,
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
	return `OK batch=${report.epoch} n=${report.contributorCount} avgCycle=${report.avgCycleLength} avgPeriod=${report.avgPeriodLength} symptoms={${symptoms}} ageShare={${ages}} avgCycleByAge={${avgByAge}} rejected=${report.rejectedCount} rewardRoot=${report.rewardMerkleRoot ?? 'none'} eligibleWallets=${report.eligibleWalletCount}`
}
