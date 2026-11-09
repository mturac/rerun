'use server'

import { deniedCode, type DeniedCode } from '@/app/api/_auth/access'
import { readSessionObservation, clearSkillProposalAttention, getAgentChatTarget, getSessionEngineContext } from '@/app/api/_services/chat.service'
import { decideSkillProposal, listSkillProposals } from '@/lib/engine/client'
import { LOCKED_WRITE_ERROR } from '@/app/api/_services/agent-content.service'
import type { EngineSkillProposal } from '@/lib/engine/types'

export async function listSkillProposalsAction(sessionId: string): Promise<EngineSkillProposal[]> {
    try {
        const ctx = await getSessionEngineContext(sessionId)
        if (!ctx?.engineSessionId) return []
        return await listSkillProposals(ctx.conn, ctx.engineAgentId, ctx.engineSessionId)
    } catch {
        return []
    }
}

// Deciding writes, or turns down, a procedure of the coworker: `manage` on its Box, either way. A
// sealed agent's procedures belong to the template it came from, so it does not get to rewrite
// them from a chat row.
export async function decideSkillProposalAction(
    sessionId: string,
    proposalId: string,
    decision: 'accept' | 'dismiss'
): Promise<{ success: boolean; error?: string; code?: DeniedCode; proposal?: EngineSkillProposal }> {
    try {
        const ctx = await getSessionEngineContext(sessionId)
        if (!ctx) return { success: false, error: 'Coworker not reachable' }
        const { contentLocked } = await getAgentChatTarget(ctx.agentId, 'manage')
        if (decision === 'accept' && contentLocked) return { success: false, error: LOCKED_WRITE_ERROR }
        const observation = await readSessionObservation(sessionId)
        const proposal = await decideSkillProposal(ctx.conn, ctx.engineAgentId, proposalId, decision)
        await clearSkillProposalAttention(sessionId, ctx.agentId, ctx.engineSessionId, observation).catch(() => {})
        return { success: true, proposal }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update the proposal', code: deniedCode(err) }
    }
}
