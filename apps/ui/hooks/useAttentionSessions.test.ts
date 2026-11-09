import { describe, expect, it, vi } from 'vitest'

// A deterministic hook scheduler: controls effect cleanup and async read ordering without a DOM.
const harness = vi.hoisted(() => ({
    values: [] as unknown[], stateIndex: 0, effectIndex: 0,
    effects: [] as { deps: unknown[]; cleanup?: () => void }[],
    subscription: null as null | { onInsert: (row: { agent_id: string }) => void; onResync: () => void },
    notifications: [] as unknown[],
    sessions: [{ id: 's', agentId: 'a', status: 'awaiting_ack', observation: { kind: 'execution', runId: 'r', revision: 3, attentionRevision: 2, projectionVersion: 3 } }],
    reads: vi.fn(),
}))
vi.mock('react', async importOriginal => ({
    ...(await importOriginal<object>()),
    useMemo: (compute: () => unknown) => compute(),
    useState: (initial: unknown) => {
        const index = harness.stateIndex++
        if (!(index in harness.values)) harness.values[index] = initial
        return [harness.values[index], (value: unknown) => { harness.values[index] = typeof value === 'function' ? value(harness.values[index]) : value }]
    },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
        const index = harness.effectIndex++
        const previous = harness.effects[index]
        if (previous && deps.every((dep, i) => dep === previous.deps[i])) return
        previous?.cleanup?.()
        harness.effects[index] = { deps, cleanup: effect() || undefined }
    },
}))
vi.mock('@/stores/board.store', () => ({ useBoardStore: (select: (state: unknown) => unknown) => select({ sessions: harness.sessions }) }))
vi.mock('@/supabase/session/SessionProvider', () => ({ useSession: () => ({ user: { id: 'u' } }) }))
vi.mock('@/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/supabase/useRealtimeSubscription', () => ({ useRealtimeSubscription: (_table: string, options: typeof harness.subscription) => { harness.subscription = options } }))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMany: async (_client: unknown, table: string) => {
    harness.reads(table)
    return { data: table === 'sessions' ? [{ id: 's', agent_id: 'a', engine_session_id: 'es', title: 'Chat', updated_at: 'now', execution_revision: 3, execution_attention_revision: 2 }] : harness.notifications, error: null }
} }))

const { useAttentionSessions } = await import('./useAttentionSessions')
function render() {
    harness.stateIndex = 0
    harness.effectIndex = 0
    return useAttentionSessions()
}
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve() }

describe('attention details arriving after the session projection', () => {
    it('refreshes on the later inbox insert and reconnect, and matches the attention revision', async () => {
        render()
        await flush()
        expect(render()[0].message).toBeNull()
        harness.notifications = [
            { agent_id: 'a', engine_session_id: 'es', execution_revision: 1, kind: 'info', message: 'old text', metadata: null, recipients: null },
            { agent_id: 'a', engine_session_id: 'es', execution_revision: 2, kind: 'info', message: 'current attention', metadata: null, recipients: null },
        ]
        harness.subscription!.onInsert({ agent_id: 'a' })
        render()
        await flush()
        expect(render()[0].message).toBe('current attention')
        const count = harness.reads.mock.calls.length
        harness.subscription!.onResync()
        render()
        await flush()
        expect(harness.reads.mock.calls.length).toBeGreaterThan(count)
    })
})
