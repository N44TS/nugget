import { describe, expect } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import {
	aggregateContributions,
	isValidContribution,
	parseContributionBatch,
	xorDecryptUtf8,
	xorEncryptUtf8,
	type ContributionBatch,
} from './aggregate'
import { initWorkflow, onCronTrigger, unlockContributionBatch } from './workflow'

const API_TOKEN = 'test-token'

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
	secretId: 'API_TOKEN',
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
			result: () => ({ id: request.id, value: API_TOKEN }),
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

	test('xor round-trip', () => {
		const plain = JSON.stringify(sampleBatch)
		const cipher = xorEncryptUtf8(plain, API_TOKEN)
		expect(xorDecryptUtf8(cipher, API_TOKEN)).toBe(plain)
	})

	test('unlockContributionBatch decrypts nugget1 wrapper', () => {
		const plain = JSON.stringify(sampleBatch)
		const cipher = xorEncryptUtf8(plain, API_TOKEN)
		const payload = Buffer.from(cipher).toString('base64')
		const wrapper = JSON.stringify({ encoding: 'nugget1-xor-b64', payload })
		const batch = unlockContributionBatch(wrapper, API_TOKEN)
		expect(batch.epoch).toBe('2026-W36')
		expect(batch.contributions).toHaveLength(7)
	})

	test('parseContributionBatch requires epoch', () => {
		expect(() => parseContributionBatch({ contributions: [] })).toThrow('epoch')
	})
})

describe('onCronTrigger', () => {
	test('injects the enclave-fetched secret into the outbound request', () => {
		const body = JSON.stringify(sampleBatch)
		const { runtime, capturedHeaders } = makeFakeTeeRuntime({ body })
		onCronTrigger(runtime)
		expect(capturedHeaders).toEqual([`Bearer ${API_TOKEN}`])
	})

	test('returns public aggregate summary', () => {
		const { runtime, logs } = makeFakeTeeRuntime({ body: JSON.stringify(sampleBatch) })
		const summary = onCronTrigger(runtime)
		expect(summary).toContain('OK batch=2026-W36')
		expect(summary).toContain('n=6')
		expect(summary).not.toContain(API_TOKEN)
		for (const line of logs) {
			expect(line).not.toContain(API_TOKEN)
			expect(line).not.toContain('"claimId":"c01"')
		}
	})

	test('decrypts encrypted batch with vault secret', () => {
		const plain = JSON.stringify(sampleBatch)
		const cipher = xorEncryptUtf8(plain, API_TOKEN)
		const payload = Buffer.from(cipher).toString('base64')
		const body = JSON.stringify({ encoding: 'nugget1-xor-b64', payload })
		const { runtime } = makeFakeTeeRuntime({ body })
		expect(onCronTrigger(runtime)).toContain('OK batch=2026-W36')
	})

	test('crosses back to the DON to generate a report', () => {
		const { runtime, reports } = makeFakeTeeRuntime({ body: JSON.stringify(sampleBatch) })
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
