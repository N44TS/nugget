import { describe, expect } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
	aggregateContributions,
	decryptForCre,
	decryptAuthenticatedUtf8,
	encryptAuthenticatedUtf8,
	isValidContribution,
	parseContributionBatch,
	type ContributionBatch,
} from './aggregate'
import { initWorkflow, onCronTrigger, unlockContributionBatch } from './workflow'

const RECIPIENT_PRIVATE_KEY = new Uint8Array(32).fill(7)
const PRIVATE_KEY_B64 = Buffer.from(RECIPIENT_PRIVATE_KEY).toString('base64')
const TEST_KEY = 'test-key'
const API_TOKEN = ''

const sampleBatch: ContributionBatch = {
	epoch: '2026-W36',
	contributions: [
		{ claimId: 'c01', cycleLengthDays: 28, periodLengthDays: 5, symptoms: ['cramps', 'mood'], ageBand: '25-34' },
		{ claimId: 'c02', cycleLengthDays: 30, periodLengthDays: 4, symptoms: ['cramps'], ageBand: '25-34' },
		{ claimId: 'c03', cycleLengthDays: 26, periodLengthDays: 6, symptoms: ['headache', 'mood'], ageBand: '18-24' },
		{ claimId: 'c04', cycleLengthDays: 32, periodLengthDays: 5, symptoms: ['cramps', 'fatigue'], ageBand: '25-34' },
		{ claimId: 'c05', cycleLengthDays: 27, periodLengthDays: 4, symptoms: ['mood'], ageBand: '25-34' },
		{ claimId: 'c06', cycleLengthDays: 29, periodLengthDays: 5, symptoms: ['cramps', 'headache'], ageBand: '25-34' },
		{ claimId: 'bad', cycleLengthDays: 200, periodLengthDays: 5, symptoms: ['cramps'], ageBand: '25-34' },
	],
}

const makeConfig = () => ({
	schedule: '0 */1 * * * *',
	url: 'https://example.invalid/contributions',
	secretId: 'CRE_ENCRYPTION_PRIVATE_KEY',
	kMin: 5,
})

type FakeTeeRuntimeOptions = {
	statusCode?: number
	body?: string
}

const makeFakeTeeRuntime = ({ statusCode = 200, body = '{}' }: FakeTeeRuntimeOptions = {}) => {
	const capturedHeaders: string[] = []
	const reports: unknown[] = []
	const logs: string[] = []

	const runtime = {
		config: makeConfig(),
		getSecret: (request: { id?: string }) => ({
			result: () => ({ id: request.id, value: PRIVATE_KEY_B64 }),
		}),
		callCapability: ({ payload }: { payload: { multiHeaders?: Record<string, unknown> } }) => {
			const auth = payload.multiHeaders?.Authorization as { values?: string[] } | undefined
			capturedHeaders.push(...(auth?.values ?? []))
			return {
				result: () => ({
					statusCode,
					body: new TextEncoder().encode(body),
				}),
			}
		},
		log: (message: string) => logs.push(message),
		usingTheDons: () => ({
			report: (input: unknown) => {
				reports.push(input)
				return { result: () => ({}) }
			},
		}),
	}

	return {
		runtime: runtime as unknown as TeeRuntime<ReturnType<typeof makeConfig>>,
		capturedHeaders,
		reports,
		logs,
	}
}

const encryptedBatchBody = () => {
	const recipientPublicKey = x25519.getPublicKey(RECIPIENT_PRIVATE_KEY)
	const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
	const contributions = sampleBatch.contributions.map((contribution, index) => {
		const ephemeralPrivateKey = new Uint8Array(32).fill(index + 9)
		const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, recipientPublicKey)
		const nonce = new Uint8Array(24).fill(index + 3)
		const payload = xchacha20poly1305(sha256(sharedSecret), nonce).encrypt(
			new TextEncoder().encode(JSON.stringify(contribution)),
		)
		return {
			encoding: 'nugget1-x25519-xchacha20poly1305-b64' as const,
			ephemeralPublicKey: base64(x25519.getPublicKey(ephemeralPrivateKey)),
			nonce: base64(nonce),
			payload: base64(payload),
		}
	})
	return JSON.stringify({ encoding: 'nugget1-contribution-batch-v1', epoch: sampleBatch.epoch, contributions })
}

describe('aggregate', () => {
	test('rejects out-of-range cycle lengths', () => {
		expect(
			isValidContribution({
				claimId: 'x',
				cycleLengthDays: 200,
				periodLengthDays: 5,
				symptoms: [],
				ageBand: '25-34',
			}),
		).toBe(false)
	})

	test('suppresses aggregates when below kMin', () => {
		const tiny: ContributionBatch = {
			epoch: 'e',
			contributions: [
				{ claimId: 'a', cycleLengthDays: 28, periodLengthDays: 5, symptoms: ['cramps'], ageBand: '25-34' },
			],
		}
		const report = aggregateContributions(tiny, 5)
		expect(report.kAnonOk).toBe(false)
		expect(report.avgCycleLength).toBeNull()
	})

	test('aggregates valid rows including age bands when k-anon allows', () => {
		const report = aggregateContributions(sampleBatch, 3)
		expect(report.kAnonOk).toBe(true)
		expect(report.validCount).toBe(6)
		expect(report.rejectedCount).toBe(1)
		expect(report.avgCycleLength).toBeGreaterThan(20)
		expect(report.ageBandShare?.['25-34']).toBeGreaterThan(0)
		expect(report.avgCycleByAgeBand?.['25-34']).toBeGreaterThan(20)
	})

	test('authenticated encryption round-trip', () => {
		const plain = JSON.stringify(sampleBatch)
		const nonce = new Uint8Array(24)
		const cipher = encryptAuthenticatedUtf8(plain, TEST_KEY, nonce)
		expect(decryptAuthenticatedUtf8(cipher, TEST_KEY, nonce)).toBe(plain)
	})

	test('unlockContributionBatch decrypts every browser envelope', () => {
		const batch = unlockContributionBatch(encryptedBatchBody(), PRIVATE_KEY_B64)
		expect(batch.epoch).toBe('2026-W36')
		expect(batch.contributions).toHaveLength(7)
	})

	test('CRE decrypts a browser-style X25519 envelope', () => {
		const ephemeralPrivateKey = new Uint8Array(32).fill(9)
		const recipientPublicKey = x25519.getPublicKey(RECIPIENT_PRIVATE_KEY)
		const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, recipientPublicKey)
		const nonce = new Uint8Array(24).fill(3)
		const payload = xchacha20poly1305(sha256(sharedSecret), nonce).encrypt(
			new TextEncoder().encode('private contribution'),
		)
		const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
		const envelope = {
			encoding: 'nugget1-x25519-xchacha20poly1305-b64' as const,
			ephemeralPublicKey: base64(x25519.getPublicKey(ephemeralPrivateKey)),
			nonce: base64(nonce),
			payload: base64(payload),
		}

		expect(
			decryptForCre(envelope, RECIPIENT_PRIVATE_KEY, (value) => new Uint8Array(Buffer.from(value, 'base64'))),
		).toBe('private contribution')
	})

	test('parseContributionBatch requires epoch', () => {
		expect(() => parseContributionBatch({ contributions: [] })).toThrow('epoch')
	})
})

describe('onCronTrigger', () => {
	test('injects the enclave-fetched secret into the outbound request', () => {
		const body = encryptedBatchBody()
		const { runtime, capturedHeaders } = makeFakeTeeRuntime({ body })
		onCronTrigger(runtime)
		expect(capturedHeaders).toEqual([`Bearer ${API_TOKEN}`])
	})

	test('returns public aggregate summary', () => {
		const { runtime, logs } = makeFakeTeeRuntime({ body: encryptedBatchBody() })
		const summary = onCronTrigger(runtime)
		expect(summary).toContain('OK batch=2026-W36')
		expect(summary).toContain('n=6')
		for (const line of logs) {
			expect(line).not.toContain('"claimId":"c01"')
		}
	})

	test('decrypts the encrypted batch with the vault private key', () => {
		const { runtime } = makeFakeTeeRuntime({ body: encryptedBatchBody() })
		expect(onCronTrigger(runtime)).toContain('OK batch=2026-W36')
	})

	test('crosses back to the DON to generate a report', () => {
		const { runtime, reports } = makeFakeTeeRuntime({ body: encryptedBatchBody() })
		onCronTrigger(runtime)
		expect(reports).toHaveLength(1)
	})

	test('throws on a non-2xx response and never reaches the DON', () => {
		const { runtime, reports } = makeFakeTeeRuntime({ statusCode: 401 })
		expect(() => onCronTrigger(runtime)).toThrow('status: 401')
		expect(reports).toHaveLength(0)
	})
})

describe('initWorkflow', () => {
	test('registers the cron handler with a Nitro TEE constraint', () => {
		const handlers = initWorkflow(makeConfig())
		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)
		expect(handlers[0].requirements).toBeDefined()
	})
})
