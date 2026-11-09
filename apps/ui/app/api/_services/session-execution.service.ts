import type { SessionProjection, SessionObservation } from '@/lib/board/session-execution'
import type { SessionStatus } from '@/lib/board/types'
import type { SessionExecution, SessionSource } from '@/lib/engine/types'
import { createServiceRoleClient } from '@/supabase/serviceRole'

type ProjectionResult = { session_id: string; status: SessionStatus; run_id: string | null; revision: number; attention_revision: number | null; projection_version: number }

function projectionOf(row: ProjectionResult): SessionProjection {
    return {
        sessionId: row.session_id,
        status: row.status,
        observation: row.run_id && row.revision && row.projection_version ? { kind: 'execution', runId: row.run_id, revision: row.revision, attentionRevision: row.attention_revision, projectionVersion: row.projection_version } : null,
    }
}

export async function applySessionExecution(workspaceId: number, agentId: string, execution: SessionExecution, mirror?: { title?: string | null; source?: SessionSource | null; originAgentId?: string | null }): Promise<SessionProjection & { result: string }> {
    const { data, error } = await createServiceRoleClient().rpc('apply_session_execution', {
        p_workspace_id: workspaceId, p_agent_id: agentId, p_engine_session_id: execution.sessionId, p_run_id: execution.runId,
        p_revision: execution.revision, p_state: execution.state, p_attention_revision: execution.attention?.revision ?? null,
        p_attention_kind: execution.attention?.kind ?? null, p_title: mirror?.title ?? null, p_source: mirror?.source ?? null, p_origin_agent_id: mirror?.originAgentId ?? null,
    })
    if (error || !data?.[0]) throw new Error(error?.message ?? 'Failed to project session execution')
    return { ...projectionOf(data[0]), result: data[0].result }
}

export async function applyLegacySessionStatus(agentId: string, engineSessionId: string, status: SessionStatus): Promise<boolean> {
    const { data, error } = await createServiceRoleClient().rpc('apply_legacy_session_status', { p_agent_id: agentId, p_engine_session_id: engineSessionId, p_status: status })
    if (error) throw new Error(error.message)
    return data === true
}

export async function acknowledgeSessionExecution(workspaceId: number, sessionId: string, observation: SessionObservation): Promise<SessionProjection> {
    const { data, error } = await createServiceRoleClient().rpc('acknowledge_session_execution', {
        p_workspace_id: workspaceId, p_session_id: sessionId,
        p_expected_run_id: observation.kind === 'execution' ? observation.runId : null,
        p_expected_attention_revision: observation.kind === 'execution' ? observation.attentionRevision : null,
        p_expected_revision: observation.kind === 'execution' ? observation.revision : null,
        p_expected_updated_at: observation.kind === 'legacy' ? observation.updatedAt : null,
    })
    if (error || !data?.[0]) throw new Error(error?.message ?? 'Failed to acknowledge session execution')
    return projectionOf(data[0])
}
