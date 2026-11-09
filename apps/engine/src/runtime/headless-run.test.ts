import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-headless-'))
process.env.RERUN_API_KEY = ''

const state = vi.hoisted(() => ({
    started: 0,
    runIds: [] as string[],
    prepError: null as Error | null,
    calls: [] as unknown[][],
    merges: [] as Array<{ agentRun: unknown; meta: unknown }>,
}))

vi.mock('../db/repos/runs.js', () => ({
    startRun: async (_agentId: string, _sessionId: string, id: string) => {
        state.started += 1
        state.runIds.push(id)
        return { id }
    },
}))
vi.mock('./loop.js', () => ({
    runAgent: async (...args: unknown[]) => {
        state.calls.push(args)
        if (state.prepError) throw state.prepError
        return { runId: args[5], settled: Promise.resolve({ kind: 'done' }) }
    },
}))
vi.mock('./run-stream-merge.js', () => ({
    mergeRunStream: (writer: { write: (chunk: unknown) => void }, agentRun: unknown, meta: unknown) => {
        state.merges.push({ agentRun, meta })
        writer.write({ type: 'data-marker', data: { merged: true } })
    },
}))

const { afterEach, describe, expect, it } = await import('vitest')
const { startHeadlessRun } = await import('./headless-run.js')
const { subscribeRunStream } = await import('./run-streams.js')
const { releaseSession } = await import('./run-control.js')

const agent = { id: 'headless-agent', resolved: { provider: 'openai', model: 'gpt-default' } } as never
const trigger = { source: 'schedule', slug: 'daily', name: 'Daily' } as const

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let out = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) return out
        out += decoder.decode(value)
    }
}

afterEach(() => {
    for (const runId of state.runIds) releaseSession(runId)
    state.runIds = []
    state.prepError = null
    state.calls = []
    state.merges = []
})

describe('startHeadlessRun', () => {
    it('resolves with the run once it has started and hands the run loop its row id', async () => {
        const run = await startHeadlessRun(agent, 'sess-1', 'do it', undefined, trigger)

        expect(run.runId).toBe(state.runIds.at(-1))
        expect(state.calls[0]).toEqual([agent, 'sess-1', 'do it', undefined, expect.anything(), run.runId, trigger])
    })

    it('publishes the run stream so the dashboard can attach to it later', async () => {
        const run = await startHeadlessRun(agent, 'sess-2', 'do it', undefined, trigger)

        const replay = await readAll(subscribeRunStream(run.runId)!)
        expect(replay).toContain('"merged":true')
    })

    it('labels the stream with the agent model when there is no override', async () => {
        await startHeadlessRun(agent, 'sess-3', 'do it', undefined, trigger)

        expect(state.merges[0].meta).toEqual({ provider: 'openai', model: 'gpt-default' })
    })

    it('labels the stream with the override model when there is one', async () => {
        await startHeadlessRun(agent, 'sess-4', 'do it', { provider: 'rerun', model: 'fast' }, trigger)

        expect(state.merges[0].meta).toEqual({ provider: 'rerun', model: 'fast' })
    })

    it('fills a partial override from the agent', async () => {
        await startHeadlessRun(agent, 'sess-5', 'do it', { model: 'only-model' }, trigger)

        expect(state.merges[0].meta).toEqual({ provider: 'openai', model: 'only-model' })
    })

    it('rejects with the preparation error instead of losing it in the stream', async () => {
        state.prepError = new Error('no connection for provider')

        await expect(startHeadlessRun(agent, 'sess-6', 'do it', undefined, trigger)).rejects.toThrow('no connection for provider')
        expect(state.merges).toHaveLength(0)

        const replay = await readAll(subscribeRunStream(state.runIds.at(-1)!)!)
        expect(replay).toContain('no connection for provider')
    })
})
