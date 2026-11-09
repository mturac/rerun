import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { RunContext } from '../../runtime/context.js'

const dataDir = mkdtempSync(resolve(tmpdir(), 'rerun-handoff-'))
process.env.RERUN_DATA_DIR = dataDir

const { describe, expect, it, beforeAll, vi } = await import('vitest')
const { migrate } = await import('../../db/migrate.js')
const { insertAgentIndex, listAgentIndex } = await import('../../db/repos/agents.js')
const { createSession, getSession } = await import('../../db/repos/sessions.js')
const { appendMessage, listMessages } = await import('../../db/repos/messages.js')

const calleeConfigs: Record<string, { name: string; enabled: boolean }> = {
    'agent-a': { name: 'Alice', enabled: true },
    'agent-b': { name: 'Agent B', enabled: true },
    'agent-c': { name: 'Bob', enabled: true },
    'agent-d': { name: 'Disabled Dan', enabled: false },
}

const traced: { event: string; agentId?: string; sessionId?: string | null; prompt?: string; trigger?: unknown }[] = []
const runsStarted: { agentId: string; sessionId: string; prompt: string; trigger: unknown }[] = []

vi.doMock('../../runtime/notify.js', () => ({
    sendNotification: async (input: { event: string; agentId?: string; sessionId?: string | null }) => {
        traced.push(input)
        return { delivered: true }
    },
}))

vi.doMock('../../runtime/headless-run.js', () => ({
    startHeadlessRun: async (callee: { id: string }, sessionId: string, prompt: string, _override: unknown, trigger: unknown) => {
        runsStarted.push({ agentId: callee.id, sessionId, prompt, trigger })
        traced.push({ event: 'run.started', agentId: callee.id, sessionId })
        return { runId: 'run-1', result: { finishReason: Promise.resolve('stop'), fullStream: (async function* () {})() } }
    },
}))

vi.doMock('../../agents/registry.js', () => ({
    getAgent: async (id: string) => ({
        id,
        config: {
            name: calleeConfigs[id]?.name ?? id,
            enabled: calleeConfigs[id]?.enabled ?? true,
            tools: {},
            selfImprovement: { enabled: true },
        },
    }),
}))

const { handoffTools, heldIdsFromRows, HANDOFF_HELD_TAG } = await import('./handoff.js')
const { callTargetsOf } = await import('./call-agent.js')

const caller = { id: 'agent-a', config: { name: 'Alice' } }

async function ctxFor(agentId: string, sessionId: string, extra: Partial<RunContext> = {}): Promise<RunContext> {
    const targets = callTargetsOf(await listAgentIndex(), agentId)
    return { agent: { id: agentId, config: { name: agentId === 'agent-a' ? 'Alice' : calleeConfigs[agentId]?.name ?? agentId } }, sessionId, callTargets: targets, ...extra } as unknown as RunContext
}

const call = (ctx: RunContext, input: Record<string, unknown>) => (handoffTools(ctx).handoff as any).execute(input, { toolCallId: 'call-1', messages: [], abortSignal: undefined }) as Promise<string>

beforeAll(async () => {
    await migrate()
    await insertAgentIndex('agent-a', 'Alice')
    await insertAgentIndex('agent-b', 'Agent B')
    await insertAgentIndex('agent-c', 'Bob')
    await insertAgentIndex('agent-d', 'Disabled Dan')
    await insertAgentIndex('agent-e', 'Alice delegate')
})

describe('heldIdsFromRows', () => {
    it('collects held ids from handoff marker context parts', () => {
        const rows = [
            { contentJson: JSON.stringify([{ type: 'text', text: 'hello' }, { type: 'text', text: `${HANDOFF_HELD_TAG} agent-a, agent-b\nnote` }]) },
            { contentJson: JSON.stringify('plain string') },
            { contentJson: 'not json' },
        ]
        expect([...heldIdsFromRows(rows)].sort()).toEqual(['agent-a', 'agent-b'])
    })
})

describe('handoff tool', () => {
    it('hands the conversation to a coworker: transcript copied, marker written, target run started', async () => {
        const session = await createSession('agent-a', 'chat', undefined, 'dashboard')
        await appendMessage('agent-a', session.id, { role: 'user', content: 'I need a hand with the report' })
        await appendMessage('agent-a', session.id, { role: 'assistant', content: 'Let me check the numbers first.' })

        const ctx = await ctxFor('agent-a', session.id)
        const answer = await call(ctx, { agent: 'Bob', note: 'The user wants the Q3 numbers.' })

        expect(answer).toContain('Handed off to Bob')
        expect(ctx.handoffCompleted).toBe(true)
        expect(runsStarted).toHaveLength(1)
        const run = runsStarted[0]
        expect(run.agentId).toBe('agent-c')
        expect(run.prompt).toContain('handed this conversation to you')
        expect(run.prompt).toContain('Q3 numbers')
        expect(run.trigger).toEqual({ source: 'chat', callableAgentIds: undefined })

        const targetSession = await getSession('agent-c', run.sessionId)
        expect(targetSession?.originAgentId).toBe('agent-a')
        expect(targetSession?.originSessionId).toBe(session.id)

        const copied = await listMessages('agent-c', run.sessionId)
        expect(copied).toHaveLength(3)
        expect(copied[0].role).toBe('user')
        expect(copied[1].role).toBe('assistant')
        expect(JSON.parse(copied[0].contentJson)).toBe('I need a hand with the report')

        const marker = JSON.parse(copied[2].contentJson) as { type: string; text?: string }[]
        const visible = marker.filter(p => p.type === 'text').map(p => p.text).join(' ')
        expect(visible).toContain('Alice passed this conversation to Bob')
        const contextText = marker.map(p => (p as { text?: string }).text ?? '').join('\n')
        expect(contextText).toContain(`${HANDOFF_HELD_TAG} agent-a, agent-c`)
        expect(contextText).toContain('Q3 numbers')

        // The caller's own transcript is untouched apart from what its run appends.
        expect((await listMessages('agent-a', session.id))).toHaveLength(2)
        expect(traced.some(e => e.event === 'agent.session.created' && e.agentId === 'agent-c')).toBe(true)
    })

    it('rejects handing back to a coworker that already held the conversation', async () => {
        const first = await createSession('agent-a', 'chain', undefined, 'dashboard')
        const ctxA = await ctxFor('agent-a', first.id)
        await call(ctxA, { agent: 'agent-b' })
        const bSessionId = runsStarted.at(-1)!.sessionId

        // Bob's session now carries the held chain {agent-a, agent-b} in its marker.
        const ctxB = await ctxFor('agent-b', bSessionId)
        const back = await call(ctxB, { agent: 'Alice' })
        expect(back).toContain('handoff rejected')
        expect(back).toContain('already held this conversation')
        expect(ctxB.handoffCompleted).toBeUndefined()

        const allowed = await call(ctxB, { agent: 'Alice', allowReturn: true })
        expect(allowed).toContain('Handed off to Alice')
        expect(ctxB.handoffCompleted).toBe(true)
    })

    it('rejects an unknown coworker and a switched-off one without starting a run', async () => {
        const session = await createSession('agent-a', 'refusals', undefined, 'dashboard')
        const ctx = await ctxFor('agent-a', session.id)
        const before = runsStarted.length

        expect(await call(ctx, { agent: 'ghost' })).toContain('not found')
        expect(await call(ctx, { agent: 'Disabled Dan' })).toContain('switched off')
        expect(await call(ctx, { agent: 'agent-e' })).toContain('not found')
        expect(runsStarted).toHaveLength(before)
        expect(ctx.handoffCompleted).toBeUndefined()
    })

    it('exposes the handoff tool only when a roster exists', () => {
        expect('handoff' in handoffTools({ callTargets: [] } as unknown as RunContext)).toBe(true)
        const empty = handoffTools({ callTargets: [] } as unknown as RunContext)
        expect((empty.handoff as { description?: string }).description).not.toContain('Coworkers you can hand off to')
    })
})
