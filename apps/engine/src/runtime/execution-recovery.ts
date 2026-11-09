import { advanceExecution, executionRecoveryCandidates, type ExecutionSnapshot } from '../db/repos/execution.js'
import { logger } from '../lib/logger.js'

export type RecoveredExecution = { execution: ExecutionSnapshot; runStatus: string | null; needsReview: boolean }

// Startup runs before the HTTP server admits new work. Only a durable terminal intent permits
// recovery to idle; a partially written or legacy intent stays visibly in error for review.
export async function recoverSessionExecutions(agentId: string): Promise<RecoveredExecution[]> {
    const recovered: RecoveredExecution[] = []
    for (const { head, run } of await executionRecoveryCandidates(agentId)) {
        if (run?.status === 'running') continue
        const ownsRow = run?.agentId === agentId && run.sessionId === head.sessionId
        const known = ownsRow && run.executionTerminalIntent && ['done', 'cancelled', 'error'].includes(run.status)
        const state = known && run.status !== 'error' ? 'idle' : 'error'
        const attention = known && run.status === 'done' ? run.executionTerminalAttention : null
        const execution = await advanceExecution(agentId, head.sessionId, head.runId, { kind: 'terminal', state, ...(attention ? { attention } : {}) }, head.revision)
        if (!execution) continue
        if (!known) logger.error({ agent: agentId, session: head.sessionId, run: head.runId }, 'execution recovery needs review: terminal intent unavailable')
        recovered.push({ execution, runStatus: run?.status ?? null, needsReview: !known })
    }
    return recovered
}
