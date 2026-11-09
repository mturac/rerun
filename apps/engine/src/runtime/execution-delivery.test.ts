import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-delivery-'))
process.env.RERUN_API_KEY = 'test'
process.env.RERUN_HUB_BASE_URL = 'https://hub.test'

const { afterEach, describe, expect, it, vi } = await import('vitest')
const { createSession } = await import('../db/repos/sessions.js')
const { startRun } = await import('../db/repos/runs.js')
const { advanceExecution, pendingExecutions, acknowledgeExecutionDelivery, deferExecutionDelivery } = await import('../db/repos/execution.js')
const { closeSystemDb } = await import('../db/systemDb.js')
const { flushExecutionDeliveries, startExecutionDelivery } = await import('./execution-delivery.js')
const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers() })

describe('durable latest execution delivery', () => {
    it('replays only the latest committed snapshot after a process restart and acknowledges it durably', async () => {
        const agent = 'latest'
        const session = await createSession(agent, 'Scheduled research', { originAgentId: 'caller', originSessionId: 'origin' }, 'schedule')
        const run = await startRun(agent, session.id)
        await advanceExecution(agent, session.id, run.id, { kind: 'attention', attention: 'question' })
        await advanceExecution(agent, session.id, run.id, { kind: 'terminal', state: 'idle' })
        closeSystemDb(agent)
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }))
        globalThis.fetch = fetchMock
        expect(await flushExecutionDeliveries([agent], 1000)).toBe(1)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        expect(payload).toMatchObject({ event: 'agent.execution.updated', message: 'Execution updated', title: 'Scheduled research', source: 'schedule', originAgentId: 'caller', execution: { revision: 3, state: 'idle', attention: { kind: 'question', revision: 2 } } })
        closeSystemDb(agent)
        expect(await pendingExecutions(agent, 1000)).toHaveLength(0)
        expect(await flushExecutionDeliveries([agent], 1000)).toBe(0)
    })

    it('persists a failed attempt and retries only after its backoff, including across restart', async () => {
        const agent = 'backoff'
        const session = await createSession(agent)
        await startRun(agent, session.id)
        globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 }))
        expect(await flushExecutionDeliveries([agent], 1000)).toBe(1)
        closeSystemDb(agent)
        expect(await pendingExecutions(agent, 5999)).toHaveLength(0)
        expect(await pendingExecutions(agent, 6000)).toHaveLength(1)
        globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }))
        expect(await flushExecutionDeliveries([agent], 6000)).toBe(1)
        expect(await pendingExecutions(agent, 6000)).toHaveLength(0)
    })

    it('does not acknowledge a newer owner when an earlier HTTP request completes', async () => {
        const agent = 'inflight'
        const session = await createSession(agent)
        const first = await startRun(agent, session.id)
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        let entered!: () => void
        const enteredPromise = new Promise<void>(resolve => { entered = resolve })
        globalThis.fetch = vi.fn(async () => { entered(); await held; return new Response(null, { status: 200 }) })
        const flushing = flushExecutionDeliveries([agent], 1000, 1)
        await enteredPromise
        const second = await startRun(agent, session.id)
        release()
        await flushing
        const pending = await pendingExecutions(agent, 1000)
        expect(pending).toHaveLength(1)
        expect(pending[0].execution).toMatchObject({ runId: second.id, revision: 2 })
        expect(await acknowledgeExecutionDelivery({ agentId: agent, sessionId: session.id, runId: first.id, revision: 1, state: 'working', attention: null })).toBe(false)
    })

    it('caps a flush batch and leaves the remaining heads pending', async () => {
        const agent = 'batch'
        for (let index = 0; index < 3; index++) {
            const session = await createSession(agent)
            await startRun(agent, session.id)
        }
        globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }))
        expect(await flushExecutionDeliveries([agent], 1000, 2)).toBe(2)
        expect(await pendingExecutions(agent, 1000)).toHaveLength(1)
    })

    it('caps retry backoff and makes a new attention revision immediately eligible again', async () => {
        const agent = 'capped-backoff'
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        const [pending] = await pendingExecutions(agent, 1000)
        await deferExecutionDelivery(pending.execution, 20, 1000)
        expect(await pendingExecutions(agent, 300999)).toHaveLength(0)
        expect(await pendingExecutions(agent, 301000)).toHaveLength(1)
        await advanceExecution(agent, session.id, run.id, { kind: 'attention', attention: 'ack' })
        expect(await pendingExecutions(agent, 1000)).toEqual([expect.objectContaining({ attempts: 0, execution: expect.objectContaining({ revision: 2, attention: { kind: 'ack', revision: 2 } }) })])
    })

    it('does not overlap polls while a flush is still pending, and stops scheduling on shutdown', async () => {
        vi.useFakeTimers()
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        const flush = vi.fn(async () => { await held })
        const stop = startExecutionDelivery(flush)
        await vi.advanceTimersByTimeAsync(20_000)
        expect(flush).toHaveBeenCalledTimes(1)
        stop()
        release()
        await vi.advanceTimersByTimeAsync(20_000)
        expect(flush).toHaveBeenCalledTimes(1)
    })
})
