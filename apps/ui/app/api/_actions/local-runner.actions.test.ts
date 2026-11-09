import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeSupabase, type FakeSupabase } from '@/test/supabase-fake'

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getWorkspaceConnection: vi.fn(),
    listRunnerApprovals: vi.fn(),
    resolveRunnerApproval: vi.fn(),
}))

vi.mock('@/supabase/session/getServerSession', () => ({ getServerSession: mocks.getServerSession, getSessionWorkspace: mocks.getServerSession }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({
    getWorkspaceConnection: mocks.getWorkspaceConnection,
    NoEngineError: class NoEngineError extends Error {
        constructor(message = 'This workspace has no machine yet') {
            super(message)
            this.name = 'NoEngineError'
        }
    },
}))
vi.mock('@/lib/engine/client', () => ({
    listRunnerApprovals: mocks.listRunnerApprovals,
    resolveRunnerApproval: mocks.resolveRunnerApproval,
}))

const { createServiceRoleClient } = await import('@/supabase/serviceRole')
const { NoEngineError } = await import('@/app/api/_services/workspace-engine.service')
const { listRunnerApprovalsAction, resolveRunnerApprovalAction } = await import('./local-runner.actions')

const WORKSPACE_ID = 7
const CONN = { baseUrl: 'http://engine.test', apiKey: 'key' }

function database(role: 'admin' | 'member' = 'admin'): FakeSupabase {
    const db = fakeSupabase(table => (table === 'workspace_members' ? { data: { user_id: 'user-1', role } } : undefined))
    vi.mocked(createServiceRoleClient).mockReturnValue(db.client)
    return db
}

function signedIn() {
    mocks.getServerSession.mockResolvedValue({
        user: { id: 'user-1', workspace_id: WORKSPACE_ID },
        workspace: { id: WORKSPACE_ID, name: 'Acme' },
        session: { id: 'user-1', email: 'me@acme.test' },
        workspaceRefused: false,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    signedIn()
    mocks.getWorkspaceConnection.mockResolvedValue(CONN)
})

describe('listRunnerApprovalsAction', () => {
    it('returns the pendings the engine proxies from the runners', async () => {
        database('member')
        const approvals = [{ id: 'p1', approvalText: 'Run shell command: ls', taskKey: 'k', kind: 'shell', subject: 'repo-a', runnerId: 'r1', runnerName: 'mac' }]
        mocks.listRunnerApprovals.mockResolvedValue({ approvals, errors: ['old-mac: timeout'] })

        const result = await listRunnerApprovalsAction()

        expect(result).toEqual({ ok: true, approvals, errors: ['old-mac: timeout'] })
        expect(mocks.getWorkspaceConnection).toHaveBeenCalledWith(WORKSPACE_ID)
        expect(mocks.listRunnerApprovals).toHaveBeenCalledWith(CONN)
    })

    it('reads as empty when the workspace has no machine yet', async () => {
        database()
        mocks.getWorkspaceConnection.mockRejectedValue(new NoEngineError())

        await expect(listRunnerApprovalsAction()).resolves.toEqual({ ok: true, approvals: [], errors: [] })
        expect(mocks.listRunnerApprovals).not.toHaveBeenCalled()
    })
})

describe('resolveRunnerApprovalAction', () => {
    it('refuses a member who is not an admin', async () => {
        database('member')

        const result = await resolveRunnerApprovalAction({ id: 'p1', decision: 'approve' })

        expect(result).toEqual({ ok: false, error: 'Only an admin can approve runner tasks' })
        expect(mocks.resolveRunnerApproval).not.toHaveBeenCalled()
    })

    it('forwards the decision with the runner that holds the approval', async () => {
        database('admin')
        mocks.resolveRunnerApproval.mockResolvedValue({ status: 'completed', taskKey: 'k' })

        const result = await resolveRunnerApprovalAction({ id: 'p1', runner: 'r1', decision: 'approve', scope: 'always' })

        expect(result).toEqual({ ok: true, status: 'completed', taskKey: 'k' })
        expect(mocks.resolveRunnerApproval).toHaveBeenCalledWith(CONN, 'p1', { decision: 'approve', runner: 'r1', scope: 'always' })
    })

    it('rejects a malformed decision', async () => {
        database('admin')

        const result = await resolveRunnerApprovalAction({ id: '', decision: 'approve' })

        expect(result.ok).toBe(false)
        expect(mocks.resolveRunnerApproval).not.toHaveBeenCalled()
    })
})
