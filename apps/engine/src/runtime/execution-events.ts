import { admissionExecution, acknowledgeExecutionDelivery, type ExecutionSnapshot } from '../db/repos/execution.js'
import type { RunRow } from '../db/schema.js'
import { sendNotification } from './notify.js'
import { logger } from '../lib/logger.js'
import { getSession } from '../db/repos/sessions.js'

export function publishExecutionStart(run: Pick<RunRow, 'agentId' | 'sessionId' | 'id' | 'executionStartRevision'>): void {
    const execution = admissionExecution(run)
    if (!execution) return
    void publishExecution(execution).catch(error => logger.warn({ err: String(error), run: run.id }, 'execution start delivery failed'))
}

export async function publishExecution(execution: ExecutionSnapshot): Promise<{ delivered: boolean; reason?: string }> {
    const session = await getSession(execution.agentId, execution.sessionId)
    if (!session) throw new Error('execution delivery session is missing')
    // The hub's payload schema requires a non-empty message even though it never stores one for
    // this event: the snapshot in `execution` is the whole payload.
    const result = await sendNotification({ event: 'agent.execution.updated', kind: 'info', agentId: execution.agentId, sessionId: execution.sessionId, runId: execution.runId, message: 'Execution updated', execution, title: session.title, source: session.source, originAgentId: session.originAgentId })
    if (result.delivered) await acknowledgeExecutionDelivery(execution)
    return result
}
