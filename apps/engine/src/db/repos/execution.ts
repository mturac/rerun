import { and, eq, lt, lte, sql, asc } from 'drizzle-orm'
import { z } from 'zod'
import { getSystemDb } from '../systemDb.js'
import { runs, sessionExecutionHeads, type RunRow } from '../schema.js'

const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const attentionKindSchema = z.enum(['ack', 'question', 'approval', 'connector'])
export const executionSnapshotSchema = z.object({
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    revision: revisionSchema,
    state: z.enum(['working', 'idle', 'error']),
    attention: z.object({ kind: attentionKindSchema, revision: revisionSchema }).nullable(),
}).refine(value => value.attention === null || value.attention.revision <= value.revision, 'attention revision exceeds execution revision')

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>
export type AttentionKind = z.infer<typeof attentionKindSchema>
type Head = typeof sessionExecutionHeads.$inferSelect

function snapshot(agentId: string, row: Head): ExecutionSnapshot {
    return executionSnapshotSchema.parse({
        agentId,
        sessionId: row.sessionId,
        runId: row.runId,
        revision: row.revision,
        state: row.state,
        attention: row.attentionKind === null ? null : { kind: row.attentionKind, revision: row.attentionRevision },
    })
}

export function admissionExecution(run: Pick<RunRow, 'agentId' | 'sessionId' | 'id' | 'executionStartRevision'>): ExecutionSnapshot | null {
    if (run.executionStartRevision === null || run.executionStartRevision === undefined) return null
    return executionSnapshotSchema.parse({ agentId: run.agentId, sessionId: run.sessionId, runId: run.id, revision: run.executionStartRevision, state: 'working', attention: null })
}

export async function getSessionExecution(agentId: string, sessionId: string): Promise<ExecutionSnapshot | null> {
    const { db } = await getSystemDb(agentId)
    const [head] = await db.select().from(sessionExecutionHeads).where(eq(sessionExecutionHeads.sessionId, sessionId)).limit(1)
    return head ? snapshot(agentId, head) : null
}

type Transition = { kind: 'attention'; attention: AttentionKind } | { kind: 'terminal'; state: 'idle' | 'error'; attention?: AttentionKind }

export async function advanceExecution(agentId: string, sessionId: string, runId: string, transition: Transition, expectedRevision?: number): Promise<ExecutionSnapshot | null> {
    const { db } = await getSystemDb(agentId)
    const nextRevision = sql`${sessionExecutionHeads.revision} + 1`
    const attention = transition.attention
    const patch = transition.kind === 'attention'
        ? { revision: nextRevision, attentionKind: attention, attentionRevision: nextRevision }
        : transition.state === 'error'
            ? { revision: nextRevision, state: transition.state, attentionKind: null, attentionRevision: null }
            : attention
                ? { revision: nextRevision, state: transition.state, attentionKind: attention, attentionRevision: nextRevision }
                : { revision: nextRevision, state: transition.state }
    const [head] = await db.update(sessionExecutionHeads).set({ ...patch, deliveryAttempts: 0, deliveryNextAttemptAt: 0 })
        .where(and(eq(sessionExecutionHeads.sessionId, sessionId), eq(sessionExecutionHeads.runId, runId), lt(sessionExecutionHeads.revision, Number.MAX_SAFE_INTEGER), expectedRevision === undefined ? undefined : eq(sessionExecutionHeads.revision, expectedRevision))).returning()
    return head ? snapshot(agentId, head) : null
}

export async function pendingExecutions(agentId: string, now: number, limit = 10): Promise<Array<{ execution: ExecutionSnapshot; attempts: number }>> {
    const { db } = await getSystemDb(agentId)
    const rows = await db.select().from(sessionExecutionHeads)
        .where(and(lt(sessionExecutionHeads.deliveryAckRevision, sessionExecutionHeads.revision), lte(sessionExecutionHeads.deliveryNextAttemptAt, now)))
        .orderBy(asc(sessionExecutionHeads.deliveryNextAttemptAt), asc(sessionExecutionHeads.sessionId)).limit(limit)
    return rows.map(row => ({ execution: snapshot(agentId, row), attempts: row.deliveryAttempts }))
}

export async function acknowledgeExecutionDelivery(execution: ExecutionSnapshot): Promise<boolean> {
    const { db } = await getSystemDb(execution.agentId)
    const updated = await db.update(sessionExecutionHeads).set({ deliveryAckRevision: execution.revision, deliveryAttempts: 0, deliveryNextAttemptAt: 0 })
        .where(and(eq(sessionExecutionHeads.sessionId, execution.sessionId), eq(sessionExecutionHeads.runId, execution.runId), eq(sessionExecutionHeads.revision, execution.revision), lt(sessionExecutionHeads.deliveryAckRevision, execution.revision)))
        .returning({ id: sessionExecutionHeads.sessionId })
    return updated.length > 0
}

export async function deferExecutionDelivery(execution: ExecutionSnapshot, attempts: number, now: number): Promise<void> {
    const { db } = await getSystemDb(execution.agentId)
    const nextAttempts = Math.min(attempts + 1, 7)
    const delay = Math.min(5_000 * 2 ** (nextAttempts - 1), 300_000)
    await db.update(sessionExecutionHeads).set({ deliveryAttempts: nextAttempts, deliveryNextAttemptAt: now + delay })
        .where(and(eq(sessionExecutionHeads.sessionId, execution.sessionId), eq(sessionExecutionHeads.runId, execution.runId), eq(sessionExecutionHeads.revision, execution.revision), lt(sessionExecutionHeads.deliveryAckRevision, execution.revision)))
}

export async function executionRecoveryCandidates(agentId: string) {
    const { db } = await getSystemDb(agentId)
    return db.select({ head: sessionExecutionHeads, run: runs }).from(sessionExecutionHeads)
        .leftJoin(runs, eq(runs.id, sessionExecutionHeads.runId))
        .where(eq(sessionExecutionHeads.state, 'working'))
}
