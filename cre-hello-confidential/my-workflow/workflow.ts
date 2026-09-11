import {
	cre,
	hexToBase64,
	ok,
	text,
	type TeeRuntime,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'
import {
	aggregateContributions,
	formatPublicSummary,
	parseContributionBatch,
	decryptForCre,
	type CreEncryptedContribution,
	type AggregateReport,
	type RewardRegistration,
} from './aggregate'

// ─── Config Schema ──────────────────────────────────────────
export const configSchema = z.object({
	schedule: z.string(),
	/** HTTP endpoint that returns ciphertext-only contribution envelopes. */
	url: z.string(),
	secretId: z.string(),
	/** Minimum cohort size before aggregate cells are released. */
	kMin: z.number().int().positive(),
	/** The fourteen-day release whose contributors may receive this payout. */
	rewardWindowId: z.string().optional(),
	/** UTC cut-off for the buyer's rolling report (normally six months). */
	reportSince: z.string().optional(),
})
type Config = z.infer<typeof configSchema>

type EncryptedContributionBatch = {
	encoding: 'nugget1-contribution-batch-v1'
	epoch: string
	contributions: CreEncryptedContribution[]
	rewardRegistrations?: CreEncryptedContribution[]
}

const isEncryptedBatch = (raw: unknown): raw is EncryptedContributionBatch => {
	if (!raw || typeof raw !== 'object') return false
	const obj = raw as Record<string, unknown>
	return (
		obj.encoding === 'nugget1-contribution-batch-v1' &&
		typeof obj.epoch === 'string' &&
		Array.isArray(obj.contributions)
	)
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64ToBytes = (b64: string): Uint8Array => {
	const cleaned = b64.replace(/[\r\n\s]/g, '')
	const pad = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0
	const len = cleaned.length
	const outLen = ((len * 3) / 4) | 0
	const out = new Uint8Array(outLen - pad)
	let outIndex = 0
	for (let i = 0; i < len; i += 4) {
		const c0 = BASE64_ALPHABET.indexOf(cleaned[i]!)
		const c1 = BASE64_ALPHABET.indexOf(cleaned[i + 1]!)
		const c2 = cleaned[i + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(cleaned[i + 2]!)
		const c3 = cleaned[i + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(cleaned[i + 3]!)
		if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('invalid base64')
		const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
		if (outIndex < out.length) out[outIndex++] = (triple >> 16) & 255
		if (outIndex < out.length) out[outIndex++] = (triple >> 8) & 255
		if (outIndex < out.length) out[outIndex++] = triple & 255
	}
	return out
}

/**
 * Unlock the contribution batch inside the enclave.
 * - If the API returns a nugget1-xor-b64 wrapper, decrypt with the vault secret.
 * - If it returns plaintext JSON, parse directly (still only after Bearer auth).
 */
export const unlockContributionBatch = (body: string, privateKeyBase64: string) => {
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		throw new Error('contribution payload is not valid JSON')
	}

	if (!isEncryptedBatch(parsed)) {
		throw new Error('contribution payload must be an encrypted batch')
	}

	const privateKey = base64ToBytes(privateKeyBase64)
	if (privateKey.length !== 32) throw new Error('CRE private key must be 32 bytes')
	const contributions = parsed.contributions.map((envelope) => {
		if (
			envelope.encoding !== 'nugget1-x25519-xchacha20poly1305-b64' ||
			typeof envelope.ephemeralPublicKey !== 'string' ||
			typeof envelope.nonce !== 'string' ||
			typeof envelope.payload !== 'string'
		) {
			throw new Error('invalid encrypted contribution envelope')
		}
		return JSON.parse(
			decryptForCre(envelope, privateKey, base64ToBytes),
		)
	})

	const rewardRegistrations = (parsed.rewardRegistrations ?? []).map((envelope) => {
		if (
			envelope.encoding !== 'nugget1-x25519-xchacha20poly1305-b64' ||
			typeof envelope.ephemeralPublicKey !== 'string' ||
			typeof envelope.nonce !== 'string' ||
			typeof envelope.payload !== 'string'
		) throw new Error('invalid encrypted reward registration')
		return JSON.parse(decryptForCre(envelope, privateKey, base64ToBytes)) as RewardRegistration
	})

	return { batch: parseContributionBatch({ epoch: parsed.epoch, contributions }), rewardRegistrations }
}

// ─── TEE Cron Callback ──────────────────────────────────────
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// Step 2: vault secret inside the enclave (auth + decrypt key)
	const encryptionPrivateKey = runtime.getSecret({ id: config.secretId }).result().value
	const apiToken = ''//used login instead of waiting for api approval for now

	// Step 3: fetch contribution batch from inside the enclave
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: config.url,
			method: 'GET',
			multiHeaders: {
				Authorization: { values: [`Bearer ${apiToken}`] },
			},
		})
		.result()

	if (!ok(response)) {
		throw new Error(`Confidential request failed with status: ${response.statusCode}`)
	}

	const body = text(response)

	// Confidential work: decrypt (if needed), validate, k-anon aggregate
	const unlocked = unlockContributionBatch(body, encryptionPrivateKey)
	const report: AggregateReport = aggregateContributions(
		unlocked.batch,
		config.kMin,
		unlocked.rewardRegistrations,
		config.rewardWindowId,
		config.reportSince,
	)
	const summary = formatPublicSummary(report)
	const simulationSummary = report.kAnonOk
		? `OK batch=${report.epoch} n=${report.contributorCount} kAnon=passed rejected=${report.rejectedCount} rewardRoot=${report.rewardMerkleRoot ?? 'none'} eligibleWallets=${report.eligibleWalletCount}`
		: `SUPPRESSED batch=${report.epoch} n=${report.contributorCount} kMin=${report.kMin}`

	// Simulation-only log — no raw rows, no secret
	runtime.log(`Enclave aggregation complete. ${simulationSummary}`)

	// Step 4: only public aggregate fields cross to the DON
	const donRuntime = runtime.usingTheDons()

	const encodedPayload = encodeAbiParameters(
		parseAbiParameters(
			'string epoch, uint256 contributorCount, bool kAnonOk, string summary',
		),
		[report.epoch, BigInt(report.contributorCount), report.kAnonOk, summary],
	)

	donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	return simulationSummary
}

// ─── Workflow Init ──────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
