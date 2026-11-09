'use server'

import { requireAdminContext, requireWorkspaceId } from '@/app/api/_auth/ownership'
import { getWorkspaceConnection, NoEngineError } from '@/app/api/_services/workspace-engine.service'
import { listRunnerApprovals, resolveRunnerApproval, type RunnerApprovalDecision } from '@/lib/engine/client'
import type { RunnerApprovalResolution, RunnerPendingApprovals } from '@/lib/engine/types'
import { z } from 'zod'

import type { ActionResult } from './space.actions'

// Ask-mode tasks parked on the workspace's `rerun local-runner` daemons. Every member can see what
// waits for a decision; approving runs a command on the machine, so it stays admin-only like the
// other machine controls.

const RUNNER_APPROVALS_ADMIN_ONLY = 'Only an admin can approve runner tasks'

const resolveSchema = z.object({
    id: z.string().min(1).max(200),
    runner: z.string().max(120).optional(),
    decision: z.enum(['approve', 'deny']),
    scope: z.enum(['once', 'always']).optional(),
})

export async function listRunnerApprovalsAction(): Promise<ActionResult<RunnerPendingApprovals>> {
    try {
        const conn = await getWorkspaceConnection(await requireWorkspaceId())
        return { ok: true, ...(await listRunnerApprovals(conn)) }
    } catch (err) {
        if (err instanceof NoEngineError) return { ok: true, approvals: [], errors: [] }
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to load runner approvals' }
    }
}

export async function resolveRunnerApprovalAction(input: { id: string; runner?: string; decision: 'approve' | 'deny'; scope?: 'once' | 'always' }): Promise<ActionResult<RunnerApprovalResolution>> {
    try {
        const body = resolveSchema.parse(input)
        const conn = await getWorkspaceConnection((await requireAdminContext(RUNNER_APPROVALS_ADMIN_ONLY)).workspace.id)
        const decision: RunnerApprovalDecision = { decision: body.decision, ...(body.runner ? { runner: body.runner } : {}), ...(body.scope ? { scope: body.scope } : {}) }
        return { ok: true, ...(await resolveRunnerApproval(conn, body.id, decision)) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to resolve the approval' }
    }
}
