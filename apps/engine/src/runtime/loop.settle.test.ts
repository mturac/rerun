import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-settle-'))

// Captured instead of sent: the assertions are about what the hub is told, which is the only thing
// that moves a conversation off "working".
const { sent, executionUpdates, stream, partial, proposal, preparation } = vi.hoisted(() => ({
    sent: [] as Array<Record<string, unknown>>,
    executionUpdates: [] as Array<Record<string, unknown>>,
    stream: { parts: [] as unknown[], turns: [] as unknown[][], calls: 0, hang: false },
    partial: { push: false },
    proposal: { push: false },
    preparation: {
        toolsGate: null as Promise<void> | null,
        authGate: null as Promise<void> | null,
        busyGate: null as Promise<void> | null,
        startGate: null as Promise<void> | null,
        appendGate: null as Promise<void> | null,
        closeGate: null as Promise<void> | null,
        stepGate: null as Promise<void> | null,
        contextUsageError: null as Error | null,
        closeError: null as Error | null,
        readError: null as Error | null,
        userAppendError: null as Error | null,
        assistantAppendError: null as Error | null,
        finishWriteError: null as Error | null,
        failWriteError: null as Error | null,
        cancelWriteError: null as Error | null,
        cleanupError: null as Error | null,
        terminalGate: null as Promise<void> | null,
        terminalAttempts: [] as string[],
        curatorCalls: 0,
        toolsEnabled: false,
        completedTools: [] as number[],
        toolsStarted: 0,
        toolsClosed: 0,
        appendStarted: 0,
        modelsStarted: 0,
        closesStarted: 0,
        authAcquired: 0,
        authReleased: 0,
        startedRuns: [] as string[],
        stepsStarted: 0,
    },
}))

vi.mock('../db/repos/runs.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../db/repos/runs.js')>()
    return {
        ...actual,
        startRun: async (...args: Parameters<typeof actual.startRun>) => {
            const row = await actual.startRun(...args)
            preparation.startedRuns.push(row.id)
            await preparation.startGate
            return row
        },
        bumpRunStep: async (...args: Parameters<typeof actual.bumpRunStep>) => {
            preparation.stepsStarted += 1
            await preparation.stepGate
            return actual.bumpRunStep(...args)
        },
        getRun: async (...args: Parameters<typeof actual.getRun>) => {
            const error = preparation.readError
            preparation.readError = null
            if (error) throw error
            return actual.getRun(...args)
        },
        finishRun: async (...args: Parameters<typeof actual.finishRun>) => {
            preparation.terminalAttempts.push('done')
            await preparation.terminalGate
            if (preparation.finishWriteError) throw preparation.finishWriteError
            return actual.finishRun(...args)
        },
        failRun: async (...args: Parameters<typeof actual.failRun>) => {
            preparation.terminalAttempts.push('error')
            await preparation.terminalGate
            if (preparation.failWriteError) throw preparation.failWriteError
            return actual.failRun(...args)
        },
        cancelRun: async (...args: Parameters<typeof actual.cancelRun>) => {
            preparation.terminalAttempts.push('cancelled')
            await preparation.terminalGate
            if (preparation.cancelWriteError) throw preparation.cancelWriteError
            return actual.cancelRun(...args)
        },
    }
})

vi.mock('../connections/opencode-plan-limits.js', () => ({
    refreshOpencodePlanLimits: () => {
        if (preparation.cleanupError) throw preparation.cleanupError
        return Promise.resolve()
    },
}))

vi.mock('./curator.js', () => ({
    runCurator: async () => { preparation.curatorCalls += 1 },
}))

vi.mock('../connections/cli-auth.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../connections/cli-auth.js')>()
    return {
        ...actual,
        ensureCliAuth: async (...args: Parameters<typeof actual.ensureCliAuth>) => {
            await preparation.authGate
            const release = await actual.ensureCliAuth(...args)
            preparation.authAcquired += 1
            return () => {
                preparation.authReleased += 1
                release()
            }
        },
    }
})

vi.mock('../db/repos/agents.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../db/repos/agents.js')>()
    return {
        ...actual,
        setAgentStatus: async (...args: Parameters<typeof actual.setAgentStatus>) => {
            if (args[1] === 'busy') await preparation.busyGate
            return actual.setAgentStatus(...args)
        },
    }
})

vi.mock('../db/repos/messages.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../db/repos/messages.js')>()
    return {
        ...actual,
        appendMessage: async (...args: Parameters<typeof actual.appendMessage>) => {
            preparation.appendStarted += 1
            await preparation.appendGate
            if (args[2].role === 'user' && preparation.userAppendError) throw preparation.userAppendError
            if (args[2].role === 'assistant' && preparation.assistantAppendError) throw preparation.assistantAppendError
            return actual.appendMessage(...args)
        },
    }
})

vi.mock('./notify.js', async importOriginal => {
    const actual = await importOriginal<typeof import('./notify.js')>()
    return {
        ...actual,
        sendNotification: async (input: Record<string, unknown>) => {
            if (input.event === 'agent.execution.updated') executionUpdates.push(input)
            else sent.push(input)
            return { delivered: true }
        },
    }
})

vi.mock('../tools/registry.js', async () => {
    const { tool } = await import('ai')
    const { z } = await import('zod')
    return {
        buildTools: async (ctx: { partialResults?: { label: string; text: string }[]; skillProposals?: { proposalId: string; mode: string; title: string }[] }) => {
            preparation.toolsStarted += 1
            await preparation.toolsGate
            if (partial.push) ctx.partialResults?.push({ label: 'Task 1 — competitors', text: 'four brands found' })
            if (proposal.push) ctx.skillProposals?.push({ proposalId: 'proposal-1', mode: 'create', title: 'Publishing checklist' })
            const tools = preparation.toolsEnabled ? {
                record: tool({
                    description: 'record a completed operation',
                    inputSchema: z.object({ number: z.number() }),
                    execute: async ({ number }) => {
                        preparation.completedTools.push(number)
                        return { receipt: `completed-${number}` }
                    },
                }),
            } : {}
            return { tools, close: async () => { preparation.toolsClosed += 1 } }
        },
    }
})

vi.mock('../agents/providers.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../agents/providers.js')>()
    const { MockLanguageModelV3 } = await import('ai/test')
    return {
        ...actual,
        resolveModel: () => {
            preparation.modelsStarted += 1
            return {
                model: new MockLanguageModelV3({
                    doStream: async () => {
                        stream.calls += 1
                        const turn = stream.turns.shift()
                        return {
                            stream: new ReadableStream({
                                start(controller) {
                                    for (const part of turn ?? stream.parts) controller.enqueue(part)
                                    // A provider that wedges never closes its stream: no finish part, no
                                    // error part, no callback of any kind.
                                    if (turn || !stream.hang) controller.close()
                                },
                            }),
                        }
                    },
                }),
                close: () => {
                    preparation.closesStarted += 1
                    if (preparation.closeError) throw preparation.closeError
                    return preparation.closeGate ?? Promise.resolve()
                },
                contextUsage: () => {
                    if (preparation.contextUsageError) throw preparation.contextUsageError
                    return undefined
                },
            }
        },
    }
})

const { afterEach, beforeAll, describe, expect, it } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { migrate } = await import('../db/migrate.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { getAgent } = await import('../agents/registry.js')
const { getAgentIndex, insertAgentIndex } = await import('../db/repos/agents.js')
const { listRunSteps } = await import('../db/repos/telemetry.js')
const { createSession } = await import('../db/repos/sessions.js')
const { getRun, startRun } = await import('../db/repos/runs.js')
const { getSessionExecution } = await import('../db/repos/execution.js')
const actualRuns = await vi.importActual<typeof import('../db/repos/runs.js')>('../db/repos/runs.js')
const { emitRunTerminal } = await import('./run-events.js')
const { listMessages } = await import('../db/repos/messages.js')
const { STREAM_CUT_RAW_REASON } = await import('./provider-errors.js')
const { runAgent } = await import('./loop.js')
const { startHeadlessRun } = await import('./headless-run.js')
const { abortRun, claimSession, sessionClaim, unregisterRunAbort } = await import('./run-control.js')
const { createServer } = await import('../http/server.js')

const id = 'settleagent'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}

const textTurn = (finishReason: { unified: string; raw?: string }): unknown[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'partial answer' },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
]

async function runToSettlement(message: string, author?: { id: string; name: string }) {
    const session = await createSession(id, message)
    const agent = await getAgent(id)
    const run = await runAgent(agent, session.id, message, undefined, undefined, undefined, { source: 'chat', author })
    return { run, sessionId: session.id, outcome: await run.settled }
}

describe('a run always reaches a terminal state', () => {
    beforeAll(async () => {
        await migrate()
        await mkdir(agentDir(id), { recursive: true })
        await writeAgentConfig(id, agentConfigSchema.parse({ name: 'settle' }))
    })

    afterEach(() => {
        vi.useRealTimers()
        sent.length = 0
        executionUpdates.length = 0
        stream.parts = []
        stream.turns = []
        stream.calls = 0
        stream.hang = false
        partial.push = false
        proposal.push = false
        preparation.toolsGate = null
        preparation.authGate = null
        preparation.busyGate = null
        preparation.startGate = null
        preparation.appendGate = null
        preparation.closeGate = null
        preparation.stepGate = null
        preparation.contextUsageError = null
        preparation.closeError = null
        preparation.readError = null
        preparation.userAppendError = null
        preparation.assistantAppendError = null
        preparation.finishWriteError = null
        preparation.failWriteError = null
        preparation.cancelWriteError = null
        preparation.cleanupError = null
        preparation.terminalGate = null
        preparation.terminalAttempts.length = 0
        preparation.curatorCalls = 0
        preparation.toolsEnabled = false
        preparation.completedTools.length = 0
        preparation.toolsStarted = 0
        preparation.toolsClosed = 0
        preparation.appendStarted = 0
        preparation.modelsStarted = 0
        preparation.closesStarted = 0
        preparation.authAcquired = 0
        preparation.authReleased = 0
        preparation.startedRuns.length = 0
        preparation.stepsStarted = 0
    })

    // A spent Codex subscription arrives as a plain finish, not as an error. Taken at face value it
    // stores an empty turn as a success and the reason the agent said nothing is lost.
    it('fails a turn the provider finished on a usage limit', async () => {
        stream.parts = textTurn({ unified: 'length', raw: 'usage_limit_exceeded' })

        const { outcome, run } = await runToSettlement('spend the quota')

        expect(outcome.kind).toBe('error')
        expect(outcome.errorCode).toBe('provider_usage_limit')
        const row = await getRun(id, run.runId)
        expect(row?.status).toBe('error')
        expect(row?.finishedAt).not.toBeNull()
        const completion = sent.find(n => n.event === 'agent.message.completed')
        expect(completion?.kind).toBe('error')
        expect((completion?.metadata as Record<string, unknown>).errorCode).toBe('provider_usage_limit')
    })

    it('keeps a plain max_tokens truncation a success', async () => {
        stream.parts = textTurn({ unified: 'length', raw: 'max_tokens' })

        const { outcome, run } = await runToSettlement('write a long answer')

        expect(outcome.kind).toBe('done')
        expect((await getRun(id, run.runId))?.status).toBe('done')
    })

    // An error part makes the SDK call onError *and then* onFinish. Both used to write the run, so
    // the `done` arriving second overwrote the failure: a spent Claude subscription was stored as a
    // successful empty turn and the session went back to idle with nothing to show for it.
    it('ends a turn the provider errored out on exactly once', async () => {
        stream.parts = [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('Claude AI usage limit reached|1750000000') },
        ]

        const { outcome, run } = await runToSettlement('spend the subscription')

        expect(outcome.kind).toBe('error')
        expect(outcome.errorCode).toBe('provider_usage_limit')
        expect((await getRun(id, run.runId))?.status).toBe('error')
        expect(sent.filter(n => n.event === 'agent.message.completed')).toHaveLength(1)
    })

    // What the stream retry middleware ends a step on when the hub hung up and the step could not be
    // replayed. It used to arrive as `other` with no usage and pass for a finished turn.
    it('fails a turn whose stream was cut, keeping what it already said', async () => {
        stream.parts = textTurn({ unified: 'error', raw: STREAM_CUT_RAW_REASON })

        const { outcome, run, sessionId } = await runToSettlement('get cut off')

        expect(outcome.kind).toBe('error')
        expect(outcome.errorCode).toBe('provider_stream_incomplete')
        expect((await getRun(id, run.runId))?.error).toContain('ended the turn without a result')
        expect(JSON.stringify(await listMessages(id, sessionId))).toContain('partial answer')
    })

    it('frees the conversation so the next message is accepted', async () => {
        stream.parts = [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('boom') },
        ]

        const { sessionId } = await runToSettlement('fail')

        expect(sessionClaim(sessionId)).toBeNull()
        expect(claimSession(sessionId, 'next-run')).toBeNull()
    })

    // Stop before the first step is the one path streamText answers with `onAbort` alone.
    it('cancels a hung run on demand and tells the hub the conversation is over', async () => {
        stream.hang = true
        stream.parts = [{ type: 'stream-start', warnings: [] }]

        const session = await createSession(id, 'hang')
        const agent = await getAgent(id)
        const run = await runAgent(agent, session.id, 'hang')

        expect(abortRun(run.runId)).toBe(true)
        const outcome = await run.settled

        expect(outcome.kind).toBe('cancelled')
        expect((await getRun(id, run.runId))?.status).toBe('cancelled')
        const completion = sent.find(n => n.event === 'agent.message.completed')
        // `done` is what puts the session back to idle on the hub; `cancelled` in the metadata is
        // what keeps it out of the notification inbox.
        expect(completion?.kind).toBe('done')
        expect((completion?.metadata as Record<string, unknown>).status).toBe('cancelled')
        expect(sessionClaim(session.id)).toBeNull()
    })

    it('does not append or start a provider after a stop during tool preparation', async () => {
        const tools = deferred()
        const auth = deferred()
        preparation.toolsGate = tools.promise
        preparation.authGate = auth.promise
        stream.hang = true
        stream.parts = [{ type: 'stream-start', warnings: [] }]
        const session = await createSession(id, 'stop during preparation')
        const row = await startRun(id, session.id)
        expect(claimSession(session.id, row.id)).toBeNull()
        const pending = runAgent(await getAgent(id), session.id, 'must not be appended', undefined, undefined, row.id).then(run => ({ run }), (error: unknown) => ({ error }))
        await vi.waitFor(() => expect(preparation.toolsStarted).toBe(1))

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            expect(abortRun(row.id)).toBe(true)
            await vi.advanceTimersByTimeAsync(30_000)
            expect(sessionClaim(session.id)?.runId).toBe(row.id)
            expect(preparation.toolsClosed).toBe(0)
            tools.resolve()
            await vi.advanceTimersByTimeAsync(30_000)
            expect(sessionClaim(session.id)?.runId).toBe(row.id)
            expect(preparation.authAcquired).toBe(0)
        } finally {
            tools.resolve()
            auth.resolve()
            vi.useRealTimers()
        }
        const started = await pending
        if ('run' in started) await started.run.settled

        expect(started).toHaveProperty('error')
        expect(preparation.modelsStarted).toBe(0)
        expect(preparation.appendStarted).toBe(0)
        expect(preparation.toolsClosed).toBe(1)
        expect(preparation.authAcquired).toBe(1)
        expect(preparation.authReleased).toBe(1)
        expect(await listMessages(id, session.id)).toEqual([])
        expect((await getRun(id, row.id))?.status).toBe('cancelled')
        expect(sessionClaim(session.id)).toBeNull()
    })

    it('finishes a delayed busy write before publishing idle and releasing the conversation', async () => {
        const busy = deferred()
        preparation.busyGate = busy.promise
        stream.hang = true
        const indexedId = 'settleindexed'
        await mkdir(agentDir(indexedId), { recursive: true })
        await writeAgentConfig(indexedId, agentConfigSchema.parse({ name: 'indexed' }))
        await insertAgentIndex(indexedId, 'indexed')
        const session = await createSession(indexedId, 'late busy')
        const row = await startRun(indexedId, session.id)
        claimSession(session.id, row.id)
        const run = await runAgent(await getAgent(indexedId), session.id, 'stop before busy is stored', undefined, undefined, row.id)

        try {
            expect(abortRun(row.id)).toBe(true)
            expect(sessionClaim(session.id)?.runId).toBe(row.id)
        } finally {
            busy.resolve()
            await run.settled
        }
        expect((await getAgentIndex(indexedId))?.status).toBe('idle')
        expect(sessionClaim(session.id)).toBeNull()
    })

    it('keeps a stopped conversation claimed while its user message append is pending', async () => {
        const append = deferred()
        preparation.appendGate = append.promise
        stream.hang = true
        const session = await createSession(id, 'pending transcript')
        const row = await startRun(id, session.id)
        claimSession(session.id, row.id)
        const run = await runAgent(await getAgent(id), session.id, 'preserve this turn', undefined, undefined, row.id)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        try {
            expect(abortRun(row.id)).toBe(true)
            await vi.advanceTimersByTimeAsync(30_000)
            expect(sessionClaim(session.id)?.runId).toBe(row.id)
            expect(preparation.closesStarted).toBe(0)
            expect(sent.filter(n => n.runId === row.id)).toHaveLength(0)
        } finally {
            append.resolve()
            vi.useRealTimers()
            await run.settled
        }
        expect(JSON.stringify(await listMessages(id, session.id))).toContain('preserve this turn')
        expect(sessionClaim(session.id)).toBeNull()
    })

    it('keeps ownership after the close warning until provider and tool cleanup really finish', async () => {
        const close = deferred()
        preparation.closeGate = close.promise
        stream.hang = true
        const session = await createSession(id, 'unresponsive close')
        const row = await startRun(id, session.id)
        claimSession(session.id, row.id)
        const run = await runAgent(await getAgent(id), session.id, 'stop the provider', undefined, undefined, row.id)
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        try {
            expect(abortRun(row.id)).toBe(true)
            await vi.waitFor(() => expect(preparation.closesStarted).toBe(1))
            expect(sessionClaim(session.id)?.runId).toBe(row.id)
            expect(abortRun(row.id)).toBe(true)
            await vi.advanceTimersByTimeAsync(15_000)

            expect(sessionClaim(session.id)?.runId).toBe(row.id)
            expect(preparation.closesStarted).toBe(1)
            expect(preparation.toolsClosed).toBe(0)
            expect(preparation.authReleased).toBe(0)
            expect(await getSessionExecution(id, session.id)).toMatchObject({ runId: row.id, state: 'working', revision: 1 })
            expect(sent.filter(n => n.runId === row.id && n.event === 'agent.message.completed')).toHaveLength(0)
        } finally {
            close.resolve()
            vi.useRealTimers()
            await run.settled
        }
        await vi.waitFor(() => expect(preparation.toolsClosed).toBe(1))
        expect(sessionClaim(session.id)).toBeNull()
        expect(preparation.authReleased).toBe(1)
        expect(await getSessionExecution(id, session.id)).toMatchObject({ runId: row.id, state: 'idle', revision: 2 })
        await vi.waitFor(() => expect(sent.filter(n => n.runId === row.id && n.event === 'agent.message.completed')).toHaveLength(1))
    })

    it('settles in error and cleans up when a provider capture throws synchronously', async () => {
        preparation.contextUsageError = new Error('context capture failed')
        stream.parts = textTurn({ unified: 'stop' })
        const session = await createSession(id, 'broken capture')
        const row = await startRun(id, session.id)
        claimSession(session.id, row.id)
        const run = await runAgent(await getAgent(id), session.id, 'finish despite capture failure', undefined, undefined, row.id)
        const outcome = await Promise.race([run.settled, new Promise<null>(resolve => setTimeout(() => resolve(null), 250))])
        try {
            expect(outcome).toMatchObject({ kind: 'error' })
            expect((await getRun(id, row.id))?.status).toBe('error')
            expect(preparation.toolsClosed).toBe(1)
            expect(sessionClaim(session.id)).toBeNull()
            await vi.waitFor(() => expect(sent.filter(n => n.runId === row.id && n.event === 'agent.message.completed')).toHaveLength(1))
        } finally {
            unregisterRunAbort(row.id)
        }
    })

    it('still closes the tools when the provider close throws synchronously', async () => {
        preparation.closeError = new Error('synchronous close failed')
        stream.parts = textTurn({ unified: 'stop' })

        const { outcome, sessionId } = await runToSettlement('finish with a broken close')

        expect(outcome.kind).toBe('done')
        expect(preparation.closesStarted).toBe(1)
        expect(preparation.toolsClosed).toBe(1)
        expect(preparation.authReleased).toBe(1)
        expect(sessionClaim(sessionId)).toBeNull()
    })

    it('waits for an in-flight step write and starts no further telemetry after Stop', async () => {
        const step = deferred()
        preparation.stepGate = step.promise
        stream.parts = textTurn({ unified: 'stop' })
        const session = await createSession(id, 'late telemetry')
        const row = await startRun(id, session.id)
        claimSession(session.id, row.id)
        const run = await runAgent(await getAgent(id), session.id, 'finish this step', undefined, undefined, row.id)
        await vi.waitFor(() => expect(preparation.stepsStarted).toBe(1))
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            expect(abortRun(row.id)).toBe(true)
            await vi.advanceTimersByTimeAsync(30_000)
            expect(sessionClaim(session.id)?.runId).toBe(row.id)
            expect((await getRun(id, row.id))?.status).toBe('running')
        } finally {
            step.resolve()
            vi.useRealTimers()
            await run.settled
        }
        expect((await getRun(id, row.id))?.status).toBe('cancelled')
        expect(await listRunSteps(id, row.id)).toEqual([])
        expect(sessionClaim(session.id)).toBeNull()
    })

    it('rejects a new chat until a stopped run finishes its transcript and close', async () => {
        const append = deferred()
        const close = deferred()
        preparation.appendGate = append.promise
        preparation.closeGate = close.promise
        stream.hang = true
        stream.parts = [{ type: 'stream-start', warnings: [] }]
        const session = await createSession(id, 'stop with pending work')
        const row = await startRun(id, session.id)
        expect(claimSession(session.id, row.id)).toBeNull()
        const run = await runAgent(await getAgent(id), session.id, 'first message', undefined, undefined, row.id)
        const app = createServer()
        const send = (message: string) => app.request(`/agents/${id}/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: session.id, message }),
        })
        const stop = () => app.request(`/agents/${id}/runs/${row.id}/cancel`, { method: 'POST' })

        try {
            expect(await (await stop()).json()).toEqual({ ok: true, aborted: true })
            expect(await (await stop()).json()).toEqual({ ok: true, aborted: true })
            const whileWriting = await send('blocked while writing')
            expect(whileWriting.status).toBe(409)
            expect(await whileWriting.json()).toMatchObject({ code: 'run_in_flight', runId: row.id })
            expect(preparation.closesStarted).toBe(0)
            expect(sent.filter(n => n.runId === row.id)).toHaveLength(0)

            append.resolve()
            await vi.waitFor(() => expect(preparation.closesStarted).toBe(1))
            const whileClosing = await send('blocked while closing')
            expect(whileClosing.status).toBe(409)
            expect(await whileClosing.json()).toMatchObject({ code: 'run_in_flight', runId: row.id })

            close.resolve()
            expect((await run.settled).kind).toBe('cancelled')
            stream.hang = false
            stream.parts = textTurn({ unified: 'stop' })
            const next = await send('second message')
            expect(next.status).toBe(200)
            await next.text()
            await vi.waitFor(() => expect(sent.filter(n => n.runId === row.id && n.event === 'agent.message.completed')).toHaveLength(1))
            const transcript = JSON.stringify(await listMessages(id, session.id))
            expect(transcript).toContain('first message')
            expect(transcript).toContain('second message')
            expect(transcript).not.toContain('blocked while')
        } finally {
            append.resolve()
            close.resolve()
            await run.settled
        }
    })

    it('stops a claimed chat whose run row exists before its loop registers', async () => {
        const start = deferred()
        preparation.startGate = start.promise
        stream.hang = true
        const session = await createSession(id, 'stop before registration')
        const app = createServer()
        const send = (message: string) => app.request(`/agents/${id}/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: session.id, message }),
        })
        const pending = send('must not start')
        await vi.waitFor(() => expect(preparation.startedRuns).toHaveLength(1))
        const runId = preparation.startedRuns[0]
        let response: Response | undefined

        try {
            const stop = () => app.request(`/agents/${id}/runs/${runId}/cancel`, { method: 'POST' })
            expect(await (await stop()).json()).toEqual({ ok: true, aborted: true })
            expect(await (await stop()).json()).toEqual({ ok: true, aborted: true })
            expect(sessionClaim(session.id)?.runId).toBe(runId)
            expect(sent.filter(n => n.runId === runId)).toHaveLength(0)
        } finally {
            start.resolve()
            response = await pending
            abortRun(runId)
            await response.text()
        }
        expect(response.status).toBe(200)
        expect(preparation.toolsStarted).toBe(0)
        expect(preparation.modelsStarted).toBe(0)
        expect(preparation.appendStarted).toBe(0)
        expect((await getRun(id, runId))?.status).toBe('cancelled')
        expect(sessionClaim(session.id)).toBeNull()
        await vi.waitFor(() => expect(sent.filter(n => n.runId === runId && n.event === 'agent.message.completed')).toHaveLength(1))

        preparation.startGate = null
        stream.hang = false
        stream.parts = textTurn({ unified: 'stop' })
        const next = await send('accepted after stopped launch')
        expect(next.status).toBe(200)
        await next.text()
    })

    it('stops a headless run between its row insert and loop registration', async () => {
        const start = deferred()
        preparation.startGate = start.promise
        stream.hang = true
        const session = await createSession(id, 'stop automated startup')
        const pending = startHeadlessRun(await getAgent(id), session.id, 'must not run', undefined, { source: 'schedule', slug: 'daily', name: 'Daily' }).then(run => ({ run }), (error: unknown) => ({ error }))
        await vi.waitFor(() => expect(preparation.startedRuns).toHaveLength(1))
        const runId = preparation.startedRuns[0]
        const app = createServer()
        try {
            const response = await app.request(`/agents/${id}/runs/${runId}/cancel`, { method: 'POST' })
            expect(await response.json()).toEqual({ ok: true, aborted: true })
            expect(sessionClaim(session.id)?.runId).toBe(runId)
            expect(sent.filter(n => n.runId === runId)).toHaveLength(0)
        } finally {
            start.resolve()
            const result = await pending
            if ('run' in result) {
                abortRun(runId)
                await result.run.settled
            }
        }
        expect(preparation.toolsStarted).toBe(0)
        expect(preparation.modelsStarted).toBe(0)
        expect(preparation.appendStarted).toBe(0)
        expect((await getRun(id, runId))?.status).toBe('cancelled')
        expect(sessionClaim(session.id)).toBeNull()
        await vi.waitFor(() => expect(sent.filter(n => n.runId === runId && n.event === 'agent.schedule.completed')).toHaveLength(1))
    })

    it('does not restart or reannounce a row already cancelled by the orphan route', async () => {
        const session = await createSession(id, 'cancelled before startup')
        const row = await startRun(id, session.id)
        const app = createServer()
        expect(await (await app.request(`/agents/${id}/runs/${row.id}/cancel`, { method: 'POST' })).json()).toEqual({ ok: true, aborted: false })
        const cancelled = await getRun(id, row.id)

        await expect(runAgent(await getAgent(id), session.id, 'must stay stopped', undefined, undefined, row.id)).rejects.toThrow('run is no longer running')

        expect(await getRun(id, row.id)).toEqual(cancelled)
        expect(preparation.toolsStarted).toBe(0)
        expect(preparation.modelsStarted).toBe(0)
        expect(preparation.appendStarted).toBe(0)
        expect(sessionClaim(session.id)).toBeNull()
        expect(sent.filter(n => n.runId === row.id && n.event === 'agent.message.completed')).toHaveLength(1)
    })

    it.each([
        ['the user message', () => { preparation.userAppendError = new Error('user append failed') }],
        ['the assistant message', () => { preparation.assistantAppendError = new Error('assistant append failed') }],
        ['the terminal row', () => { preparation.finishWriteError = new Error('finish write failed') }],
    ])('reports an error when saving %s fails', async (_label, arrange) => {
        arrange()
        stream.parts = textTurn({ unified: 'stop' })

        const { run, outcome, sessionId } = await runToSettlement('do not report a false success')

        expect(outcome.kind).toBe('error')
        expect((await getRun(id, run.runId))?.status).toBe('error')
        expect(sessionClaim(sessionId)).toBeNull()
        await vi.waitFor(() => expect(sent.filter(n => n.runId === run.runId && n.event === 'agent.message.completed')).toHaveLength(1))
        expect(sent.find(n => n.runId === run.runId)?.kind).toBe('error')
    })

    it('reports failed terminal persistence without claiming the row was saved', async () => {
        preparation.finishWriteError = new Error('finish write failed')
        preparation.failWriteError = new Error('error write also failed')
        stream.parts = textTurn({ unified: 'stop' })

        const { run, outcome } = await runToSettlement('database unavailable')

        expect(outcome.kind).toBe('error')
        expect(outcome.error).toContain('error write also failed')
        expect((await getRun(id, run.runId))?.status).toBe('running')
        await vi.waitFor(() => expect(sent.find(n => n.runId === run.runId)?.kind).toBe('error'))
    })

    it('reports an error when the cancellation row cannot be saved', async () => {
        preparation.cancelWriteError = new Error('cancel write failed')
        stream.hang = true
        const session = await createSession(id, 'cancellation write failure')
        const run = await runAgent(await getAgent(id), session.id, 'stop safely')

        expect(abortRun(run.runId)).toBe(true)
        expect((await run.settled).kind).toBe('error')
        expect((await getRun(id, run.runId))?.status).toBe('error')
        await vi.waitFor(() => expect(sent.find(n => n.runId === run.runId)?.kind).toBe('error'))
    })

    it('fails and announces a precreated row when its startup read fails', async () => {
        const session = await createSession(id, 'startup read failure')
        const row = await startRun(id, session.id)
        claimSession(session.id, row.id)
        preparation.readError = new Error('startup read failed')

        await expect(runAgent(await getAgent(id), session.id, 'never starts', undefined, undefined, row.id)).rejects.toThrow('startup read failed')

        expect((await getRun(id, row.id))?.status).toBe('error')
        expect(sessionClaim(session.id)).toBeNull()
        expect(preparation.modelsStarted).toBe(0)
        expect(sent.filter(n => n.runId === row.id && n.event === 'agent.message.completed')).toHaveLength(1)
        expect(sent.find(n => n.runId === row.id)?.kind).toBe('error')
    })

    it('releases ownership and settles even when cleanup metadata throws synchronously', async () => {
        preparation.cleanupError = new Error('plan refresh failed')
        stream.parts = textTurn({ unified: 'stop' })
        const session = await createSession(id, 'broken cleanup metadata')
        const run = await runAgent(await getAgent(id), session.id, 'completed work', { provider: 'opencode', model: 'opencode-test' })
        const outcome = await Promise.race([run.settled, new Promise<null>(resolve => setTimeout(() => resolve(null), 250))])
        try {
            expect(outcome).toMatchObject({ kind: 'done' })
            expect(sessionClaim(session.id)).toBeNull()
            expect(preparation.toolsClosed).toBe(1)
            expect(preparation.authReleased).toBe(1)
        } finally {
            unregisterRunAbort(run.runId)
        }
    })

    it('keeps the two completed tool steps once when the next step is stopped', async () => {
        preparation.toolsEnabled = true
        stream.hang = true
        stream.parts = [{ type: 'stream-start', warnings: [] }]
        stream.turns = [1, 2].map(number => [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `record-${number}`, toolName: 'record', input: JSON.stringify({ number }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ])
        const session = await createSession(id, 'preserve completed effects')
        const run = await runAgent(await getAgent(id), session.id, 'perform two operations')
        await vi.waitFor(() => expect(stream.calls).toBe(3))
        expect(preparation.completedTools).toEqual([1, 2])

        expect(abortRun(run.runId)).toBe(true)
        expect((await run.settled).kind).toBe('cancelled')

        const messages = await listMessages(id, session.id)
        const tools = messages.filter(row => row.role === 'tool')
        expect(tools).toHaveLength(2)
        expect(tools[0].contentJson).toContain('completed-1')
        expect(tools[1].contentJson).toContain('completed-2')
        expect(messages.filter(row => row.role === 'assistant')).toHaveLength(3)
        expect(messages.at(-1)?.contentJson).toContain('Run stopped by the user')
    })

    it.each([
        ['done', 'cancelled'],
        ['done', 'error'],
        ['cancelled', 'done'],
        ['cancelled', 'error'],
        ['error', 'done'],
        ['error', 'cancelled'],
    ])('adopts the DB winner when %s settlement loses to %s', async (proposed, winner) => {
        const gate = deferred()
        preparation.terminalGate = gate.promise
        proposal.push = true
        stream.hang = proposed === 'cancelled'
        stream.parts = proposed === 'error'
            ? [{ type: 'stream-start', warnings: [] }, { type: 'error', error: new Error('provider failure') }]
            : proposed === 'done' ? textTurn({ unified: 'stop' }) : []
        const session = await createSession(id, 'terminal ownership')
        const run = await runAgent(await getAgent(id), session.id, 'keep the actual history')
        if (proposed === 'cancelled') expect(abortRun(run.runId)).toBe(true)
        await vi.waitFor(() => expect(preparation.terminalAttempts).toEqual([proposed]))

        try {
            if (winner === 'done') await actualRuns.finishRun(id, run.runId, { totalTokens: 2 }, 1)
            else if (winner === 'cancelled') await actualRuns.cancelRun(id, run.runId)
            else await actualRuns.failRun(id, run.runId, 'peer failure')
            await emitRunTerminal({ agentId: id, sessionId: session.id, runId: run.runId, trigger: { source: 'chat' }, kind: winner === 'error' ? 'error' : 'done', cancelled: winner === 'cancelled', error: winner === 'error' ? 'peer failure' : undefined })
        } finally {
            gate.resolve()
        }

        const outcome = await run.settled
        expect(outcome.kind).toBe(winner)
        if (winner === 'error') expect(outcome.error).toBe('peer failure')
        expect((await getRun(id, run.runId))?.status).toBe(winner)
        expect(sessionClaim(session.id)).toBeNull()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(sent.filter(n => n.runId === run.runId)).toHaveLength(1)
        expect(sent.filter(n => n.event === 'agent.notification')).toHaveLength(0)
        expect(preparation.curatorCalls).toBe(0)
        const messages = await listMessages(id, session.id)
        expect(messages.filter(message => message.role === 'user')).toHaveLength(1)
        if (proposed === 'done') {
            expect(messages.filter(message => message.role === 'assistant')).toHaveLength(1)
            expect(messages.find(message => message.role === 'assistant')?.contentJson).toContain('partial answer')
        }
    })

    // The order is the point: the hub puts the conversation back to idle on `done`, so a proposal
    // announced first would be cleared by the run that made it.
    it('announces a skill proposal after the run is over', async () => {
        stream.parts = textTurn({ unified: 'stop' })
        proposal.push = true

        const { outcome } = await runToSettlement('always end a post with a CTA')

        expect(outcome.kind).toBe('done')
        // `settled` resolves before the hub is told anything.
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent.map(n => [n.event, n.kind])).toEqual([
            ['agent.message.completed', 'done'],
            ['agent.notification', 'approval'],
        ])
        expect(sent[1].message).toBe('Wants to save a new skill: Publishing checklist')
        expect(sent[1].metadata).toEqual({ toolName: 'skill_propose', proposalId: 'proposal-1' })
    })

    it('names the member who sent the message on the proposal and on the completion', async () => {
        stream.parts = textTurn({ unified: 'stop' })
        proposal.push = true

        await runToSettlement('always end a post with a CTA', { id: 'u1', name: 'Marie' })

        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent.map(n => (n.metadata as Record<string, unknown>).authorId)).toEqual(['u1', 'u1'])
    })

    it('says nothing of a proposal made by a run that failed', async () => {
        stream.parts = [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('boom') },
        ]
        proposal.push = true

        await runToSettlement('fail after proposing')

        await vi.waitFor(() => expect(sent.some(n => n.event === 'agent.message.completed')).toBe(true))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(sent.filter(n => n.event === 'agent.notification')).toHaveLength(0)
    })

    it('keeps what delegated tasks had already produced when the run is stopped', async () => {
        stream.hang = true
        stream.parts = [{ type: 'stream-start', warnings: [] }]
        partial.push = true

        const session = await createSession(id, 'hang with results')
        const run = await runAgent(await getAgent(id), session.id, 'hang')
        expect(abortRun(run.runId)).toBe(true)
        expect((await run.settled).kind).toBe('cancelled')

        const kept = JSON.stringify(await listMessages(id, session.id))
        expect(kept).toContain('Run stopped by the user')
        expect(kept).toContain('four brands found')
    })
})
