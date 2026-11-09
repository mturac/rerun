import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ status: 'working', rpc: vi.fn(), notificationInsert: vi.fn() }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@rerun/cloud/email', () => ({}))
vi.mock('@/lib/ai/generate-run-title', () => ({ generateRunTitle: vi.fn() }))
vi.mock('@rerun/analytics/server', () => ({ captureServer: vi.fn(), deterministicUuid: vi.fn() }))
vi.mock('@/supabase/serviceRole', () => ({
    createServiceRoleClient: () => ({
        rpc: mocks.rpc,
        from: () => ({
            insert: mocks.notificationInsert,
            update: (value: { status: string }) => {
                const query = {
                    eq: () => query,
                    neq: () => query,
                    then: (resolve: (value: { error: null; count: number }) => unknown) => {
                        mocks.status = value.status
                        return Promise.resolve({ error: null, count: 1 }).then(resolve)
                    },
                }
                return query
            },
        }),
    }),
}))
vi.mock('@/supabase/supabase-helpers', () => ({
    selectMaybeSingle: vi.fn(async () => ({ data: { id: 'hub-agent', name: 'Agent', space_id: 'space' }, error: null })),
    selectMany: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('./chat.service', () => ({ ensureSessionRow: vi.fn() }))
vi.mock('./notification-audience.service', () => ({ writeNotificationPrefs: vi.fn() }))
vi.mock('./presence.service', () => ({ loadPresence: vi.fn() }))
vi.mock('./workspace-engine.service', () => ({ authenticateEngineToken: vi.fn(async () => ({ workspaceId: 1, isSandbox: true })) }))
vi.mock('./workspace-owner.service', () => ({ resolveWorkspaceMemberEmail: vi.fn(), resolveWorkspaceOwner: vi.fn() }))

const { recordNotification } = await import('./notification.service')

describe('execution projection at the notification boundary', () => {
    beforeEach(() => {
        mocks.notificationInsert.mockReset().mockReturnValue({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
        mocks.status = 'working'
        mocks.rpc.mockReset().mockResolvedValue({ data: [{ result: 'stale', session_id: 'hub-session', status: 'working', run_id: 'run-b', revision: 3, attention_revision: null, projection_version: 3 }], error: null })
    })

    it('suppresses side effects when the database guard rejects a null snapshot after B start', async () => {
        const result = await recordNotification('test-engine-token', { event: 'agent.notification', kind: 'info', agentId: 'engine-agent', sessionId: 'engine-session', runId: 'run-a', message: 'Old A', timestamp: '2026-11-08T00:00:00Z', execution: null })
        expect(result).toEqual({ ok: true })
        expect(mocks.notificationInsert).toHaveBeenCalledTimes(1)
        expect(mocks.rpc).not.toHaveBeenCalled()
        expect(mocks.status).toBe('working')
    })

    it('keeps B working when A cancellation arrives after B admission', async () => {
        const result = await recordNotification('test-engine-token', {
            event: 'agent.message.completed', kind: 'done', agentId: 'engine-agent', sessionId: 'engine-session', runId: 'run-a',
            message: 'Message stopped', timestamp: '2026-11-08T00:00:00Z', metadata: { status: 'cancelled' },
            execution: { agentId: 'engine-agent', sessionId: 'engine-session', runId: 'run-a', revision: 2, state: 'idle', attention: null },
        })
        expect(result).toEqual({ ok: true })
        expect(mocks.status).toBe('working')
        expect(mocks.notificationInsert).not.toHaveBeenCalled()
        expect(mocks.rpc).toHaveBeenCalledWith('apply_session_execution', expect.objectContaining({ p_run_id: 'run-a', p_revision: 2 }))
    })
})
