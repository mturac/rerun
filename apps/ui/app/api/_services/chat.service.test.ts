import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@rerun/cloud/billing', async importOriginal => ({ ...(await importOriginal<object>()), ...(await import('@/test/cloud-fakes')).CLOUD_ENTITLEMENTS }))

const mocks = vi.hoisted(() => ({
    requireLightSessionActor: vi.fn(),
    visibleSpaceIds: vi.fn(),
    selectMaybeSingle: vi.fn(),
    selectMaybeSingleWithJoins: vi.fn(),
    selectManyWithJoins: vi.fn(),
    findWorkspaceEngine: vi.fn(),
    listRuns: vi.fn(),
    getSessionExecution: vi.fn(),
    applySessionExecution: vi.fn(),
    applyLegacySessionStatus: vi.fn(),
    selectMany: vi.fn(),
    sessionUpdate: vi.fn(),
}))

vi.mock('@/app/api/_auth/access', async importOriginal => ({ ...(await importOriginal<typeof import('@/app/api/_auth/access')>()), requireLightSessionActor: mocks.requireLightSessionActor, visibleSpaceIds: mocks.visibleSpaceIds }))
vi.mock('@/supabase/serviceRole', () => ({
    createServiceRoleClient: () => ({
        from: (table: string) => ({
            update: (payload: unknown) => {
                const filters: Record<string, unknown> = {}
                const query = {
                    eq: (column: string, value: unknown) => {
                        filters[column] = value
                        return query
                    },
                    then: (resolve: (value: { error: null }) => unknown) => {
                        mocks.sessionUpdate(table, payload, filters)
                        return Promise.resolve({ error: null }).then(resolve)
                    },
                }
                return query
            },
        }),
    }),
}))
vi.mock('@/supabase/supabase-helpers', () => ({ selectMaybeSingleWithJoins: mocks.selectMaybeSingleWithJoins, selectManyWithJoins: mocks.selectManyWithJoins, selectMaybeSingle: mocks.selectMaybeSingle, selectSingle: vi.fn(), selectCount: vi.fn(), selectMany: mocks.selectMany, selectAll: vi.fn() }))
vi.mock('./session-execution.service', () => ({ applySessionExecution: mocks.applySessionExecution, applyLegacySessionStatus: mocks.applyLegacySessionStatus, acknowledgeSessionExecution: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ getSessionExecution: mocks.getSessionExecution, listRuns: mocks.listRuns, getRunSteps: vi.fn() }))
vi.mock('./workspace-engine.service', () => ({ findWorkspaceEngine: mocks.findWorkspaceEngine, NoEngineError: class NoEngineError extends Error {} }))

const { AuthorizationError } = await import('@/app/api/_auth/ownership')
const { AccessDeniedError, workspaceActor } = await import('@/app/api/_auth/access')
type Actor = import('@/app/api/_auth/access').Actor
const { projectChatAdmission, clearSkillProposalAttention, findIdleSessions, lastRunError, resolveAgentTarget, resolveAgentTargetForTrigger, summarizeSessionRuns } = await import('./chat.service')

const conn = { baseUrl: 'https://engine', apiKey: 'k' }

type AgentRow = {
    workspace_id: number
    space_id: string
    engine_agent_id: string | null
    template_id: string | null
    disabled_at: string | null
    disabled_reason: string | null
    workspaces: { subscription_status: string | null; is_sandbox: boolean } | null
    space: { visibility: string } | null
}

const admin: Actor = { kind: 'user', userId: 'u1', workspaceId: 1, role: 'admin', boxScope: 'all' }
const member = (boxScope: 'all' | 'assigned'): Actor => ({ kind: 'user', userId: 'u2', workspaceId: 1, role: 'member', boxScope })

let row: AgentRow | null

beforeEach(() => {
    row = { workspace_id: 1, space_id: 'box-1', engine_agent_id: 'e1', template_id: null, disabled_at: null, disabled_reason: null, workspaces: { subscription_status: 'active', is_sandbox: false }, space: { visibility: 'workspace' } }
    mocks.requireLightSessionActor.mockReset().mockResolvedValue(admin)
    mocks.selectMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null })
    mocks.selectMaybeSingleWithJoins.mockReset().mockImplementation(async () => ({ data: row, error: null }))
    mocks.findWorkspaceEngine.mockReset().mockResolvedValue({ instanceId: 'i1', conn, managed: true })
})

describe('resolveAgentTarget', () => {
    it('resolves the engine agent for the session caller', async () => {
        await expect(resolveAgentTarget('a1')).resolves.toEqual({ engineAgentId: 'e1', conn, contentLocked: false })
        expect(mocks.selectMaybeSingleWithJoins.mock.calls[0][4]).toEqual({ id: 'a1' })
        expect(mocks.findWorkspaceEngine).toHaveBeenCalledWith(1)
    })

    it('reads the machine of the caller, never the one of the agent it was asked about', async () => {
        row = { ...row!, workspace_id: 2 }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toBeInstanceOf(AuthorizationError)
        expect(mocks.findWorkspaceEngine).toHaveBeenCalledWith(1)
    })

    it('reports a workspace without a machine', async () => {
        mocks.findWorkspaceEngine.mockResolvedValue(null)
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toThrow()
    })

    it('skips the session lookup when the caller passes an actor, an API key or a v1 context', async () => {
        await expect(resolveAgentTarget('a1', workspaceActor(1), 'manage')).resolves.toMatchObject({ engineAgentId: 'e1' })
        expect(mocks.requireLightSessionActor).not.toHaveBeenCalled()
        expect(mocks.selectMaybeSingle).not.toHaveBeenCalled()
    })

    it('refuses an agent of another workspace than the actor one', async () => {
        await expect(resolveAgentTarget('a1', workspaceActor(2))).rejects.toBeInstanceOf(AuthorizationError)
    })

    it('refuses an agent of another workspace than the session one', async () => {
        mocks.requireLightSessionActor.mockResolvedValue({ ...admin, workspaceId: 2 })
        await expect(resolveAgentTarget('a1')).rejects.toThrow('Coworker not found')
    })

    it('refuses an agent that does not exist', async () => {
        row = null
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toBeInstanceOf(AuthorizationError)
    })

    it('lets a member use a coworker of an open Box, and refuses a change with a reason', async () => {
        await expect(resolveAgentTarget('a1', member('all'))).resolves.toMatchObject({ engineAgentId: 'e1' })
        const refused = await resolveAgentTarget('a1', member('all'), 'manage').catch(e => e)
        expect(refused).toBeInstanceOf(AccessDeniedError)
    })

    it('hides a coworker of a Box the member does not reach, as missing rather than forbidden', async () => {
        row = { ...row!, space: { visibility: 'restricted' } }
        const restricted = await resolveAgentTarget('a1', member('all')).catch(e => e)
        expect(restricted).toBeInstanceOf(AuthorizationError)
        expect(restricted).not.toBeInstanceOf(AccessDeniedError)

        row = { ...row, space: { visibility: 'workspace' } }
        await expect(resolveAgentTarget('a1', member('assigned'))).rejects.toThrow('Coworker not found')
    })

    it('lets a member who manages the Box change the coworker, and reads that grant on the Box', async () => {
        row = { ...row!, space: { visibility: 'restricted' } }
        mocks.selectMaybeSingle.mockResolvedValue({ data: { access: 'manage' }, error: null })
        await expect(resolveAgentTarget('a1', member('assigned'), 'manage')).resolves.toMatchObject({ engineAgentId: 'e1' })
        expect(mocks.selectMaybeSingle.mock.calls[0][1]).toBe('space_members')
        expect(mocks.selectMaybeSingle.mock.calls[0][3]).toEqual({ space_id: 'box-1', user_id: 'u2' })
    })

    it('tells a plan-limited agent apart from a revoked template', async () => {
        row = { ...row!, disabled_at: '2026-09-01', disabled_reason: 'plan_limit' }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toThrow(/no free coworker slot/)

        row = { ...row, disabled_reason: null }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toThrow(/no free coworker slot/)

        row = { ...row, disabled_reason: 'template_revoked' }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toThrow(/template subscription it came from has ended/)
    })

    it('refuses an agent the engine does not know yet', async () => {
        row = { ...row!, engine_agent_id: null }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).rejects.toThrow('Coworker not configured or not found')
    })

    it('seals the content of a template agent on an unpaid workspace', async () => {
        row = { ...row!, template_id: 't1', workspaces: { subscription_status: 'trialing', is_sandbox: false } }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).resolves.toMatchObject({ contentLocked: true })
    })

    it('leaves a template agent open on a paid workspace and in a sandbox', async () => {
        row = { ...row!, template_id: 't1', workspaces: { subscription_status: 'active', is_sandbox: false } }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).resolves.toMatchObject({ contentLocked: false })

        row = { ...row, workspaces: { subscription_status: null, is_sandbox: true } }
        await expect(resolveAgentTarget('a1', workspaceActor(1))).resolves.toMatchObject({ contentLocked: false })
    })
})

describe('resolveAgentTargetForTrigger', () => {
    it('resolves any agent without comparing workspaces, since the token is the authorization', async () => {
        row = { ...row!, workspace_id: 42 }
        await expect(resolveAgentTargetForTrigger('a1')).resolves.toEqual({ engineAgentId: 'e1', conn, contentLocked: false })
        expect(mocks.requireLightSessionActor).not.toHaveBeenCalled()
        expect(mocks.findWorkspaceEngine).toHaveBeenCalledWith(42)
    })

    it('answers null for a disabled agent', async () => {
        row = { ...row!, disabled_at: '2026-09-01' }
        await expect(resolveAgentTargetForTrigger('a1')).resolves.toBeNull()
    })

    it('answers null for an agent without an engine id', async () => {
        row = { ...row!, engine_agent_id: null }
        await expect(resolveAgentTargetForTrigger('a1')).resolves.toBeNull()
    })

    it('answers null for an unknown agent', async () => {
        row = null
        await expect(resolveAgentTargetForTrigger('a1')).resolves.toBeNull()
    })

    it('answers null when the workspace has no machine', async () => {
        mocks.findWorkspaceEngine.mockResolvedValue(null)
        await expect(resolveAgentTargetForTrigger('a1')).resolves.toBeNull()
    })
})

function run(id: string, sessionId: string, status: string, startedAt: string, error: string | null = null) {
    return { id, sessionId, status, startedAt, error } as Parameters<typeof summarizeSessionRuns>[0][number]
}

describe('summarizeSessionRuns', () => {
    it('keeps the runs of the session, newest first, even from an engine that ignored the filter', () => {
        const runs = [run('old', 's1', 'done', '2026-09-01'), run('other', 's2', 'running', '2026-09-03'), run('new', 's1', 'error', '2026-09-02', 'boom'), run('live', 's1', 'running', '2026-08-30')]
        const summary = summarizeSessionRuns(runs, 's1')
        expect(summary.latest?.id).toBe('new')
        expect(summary.lastDone?.id).toBe('old')
        expect(summary.running?.id).toBe('live')
    })

    it('answers nothing for a session without runs', () => {
        expect(summarizeSessionRuns([run('other', 's2', 'done', '2026-09-01')], 's1')).toEqual({ latest: undefined, lastDone: undefined, running: undefined })
    })
})

describe('lastRunError', () => {
    it('speaks only for a newest run that failed', () => {
        expect(lastRunError(run('r', 's', 'error', '2026-09-01', '  quota exceeded '))).toBe('quota exceeded')
        expect(lastRunError(run('r', 's', 'done', '2026-09-01', 'stale'))).toBeNull()
        expect(lastRunError(run('r', 's', 'error', '2026-09-01', '   '))).toBeNull()
        expect(lastRunError(undefined)).toBeNull()
    })
})

describe('findIdleSessions', () => {
    const agent = (workspaceId: number, engineAgentId: string, spaceId = 'box-1') => ({ workspace_id: workspaceId, space_id: spaceId, engine_agent_id: engineAgentId })
    beforeEach(() => {
        mocks.getSessionExecution.mockReset()
        mocks.applySessionExecution.mockReset()
        mocks.visibleSpaceIds.mockReset().mockResolvedValue('all')
    })
    it('reconciles authoritative snapshots only for reachable sessions', async () => {
        mocks.visibleSpaceIds.mockResolvedValue(new Set(['box-1']))
        mocks.selectManyWithJoins.mockResolvedValue({ data: [
            { id: 'mine', agent_id: 'a1', engine_session_id: 'es-mine', agent: agent(1, 'e1') },
            { id: 'hidden', agent_id: 'a2', engine_session_id: 'es-hidden', agent: agent(1, 'e2', 'box-2') },
            { id: 'foreign', agent_id: 'a3', engine_session_id: 'es-foreign', agent: agent(2, 'e3') },
        ], error: null })
        const execution = { agentId: 'e1', sessionId: 'es-mine', runId: 'b', revision: 4, state: 'idle', attention: null }
        mocks.getSessionExecution.mockResolvedValue(execution)
        mocks.applySessionExecution.mockResolvedValue({ sessionId: 'mine', status: 'idle' })
        await expect(findIdleSessions(['mine','hidden','foreign'], workspaceActor(1))).resolves.toEqual(['mine'])
        expect(mocks.getSessionExecution).toHaveBeenCalledTimes(1)
        expect(mocks.applySessionExecution).toHaveBeenCalledWith(1, 'a1', execution)
    })
    it('never infers idle from absent authority, an old engine, or an unreachable engine', async () => {
        mocks.selectManyWithJoins.mockResolvedValue({ data: [{ id: 's', agent_id: 'a1', engine_session_id: 'es', agent: agent(1,'e1') }], error: null })
        mocks.getSessionExecution.mockResolvedValue(null)
        await expect(findIdleSessions(['s'],workspaceActor(1))).resolves.toEqual([])
        mocks.getSessionExecution.mockRejectedValue(new Error('unsupported'))
        await expect(findIdleSessions(['s'],workspaceActor(1))).resolves.toEqual([])
        mocks.findWorkspaceEngine.mockResolvedValue(null)
        await expect(findIdleSessions(['s'],workspaceActor(1))).resolves.toEqual([])
        expect(mocks.applySessionExecution).not.toHaveBeenCalled()
    })
})

describe('clearSkillProposalAttention', () => {
    it('does not clear without an observation captured before the decision', async () => {
        mocks.sessionUpdate.mockReset()
        await clearSkillProposalAttention('s1','a1','es1')
        expect(mocks.sessionUpdate).not.toHaveBeenCalled()
    })
})

describe('chat admission execution projection', () => {
    const snapshot = { agentId: 'e1', sessionId: 'es', runId: 'b', revision: 4, state: 'working', attention: null }
    const response = (value: unknown, runId = 'b') => new Response(null, { headers: { 'x-run-id': runId, 'x-session-execution': JSON.stringify(value) } })
    beforeEach(() => {
        mocks.applySessionExecution.mockReset()
        mocks.applyLegacySessionStatus.mockReset()
    })
    it('projects the admission revision without a later unconditional working write', async () => {
        mocks.applySessionExecution.mockResolvedValue({ sessionId: 's', status: 'idle', result: 'stale' })
        await expect(projectChatAdmission(1,'a1','e1','es',response(snapshot))).resolves.toMatchObject({ status: 'idle' })
        expect(mocks.applySessionExecution).toHaveBeenCalledWith(1,'a1',snapshot)
        expect(mocks.applyLegacySessionStatus).not.toHaveBeenCalled()
    })
    it('explicitly delegates revisionless old engines to the fenced legacy reducer', async () => {
        await projectChatAdmission(1,'a1','e1','es',new Response(null))
        expect(mocks.applyLegacySessionStatus).toHaveBeenCalledWith('a1','es','working')
    })
    it('fails closed on forged identity or malformed headers rather than falling back to legacy', async () => {
        await expect(projectChatAdmission(1,'a1','other','es',response(snapshot))).rejects.toThrow('identity')
        await expect(projectChatAdmission(1,'a1','e1','es',response(snapshot,'other'))).rejects.toThrow('identity')
        await expect(projectChatAdmission(1,'a1','e1','es',new Response(null,{headers:{'x-session-execution':'broken'}}))).rejects.toThrow()
        expect(mocks.applySessionExecution).not.toHaveBeenCalled()
        expect(mocks.applyLegacySessionStatus).not.toHaveBeenCalled()
    })
})
