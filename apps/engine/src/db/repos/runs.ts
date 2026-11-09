import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { ContextOccupancy } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import { runs, sessionExecutionHeads, type RunRow } from '../schema.js'
import { newId, nowIso } from '../../lib/ids.js'
import type { AttentionKind } from './execution.js'

export type UsageBucket = {
    day: string
    model: string | null
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    reasoningTokens: number
    totalTokens: number
    costMicros: number
    runCount: number
}

export async function aggregateUsageByDay(agentId: string, sinceIso: string | null): Promise<UsageBucket[]> {
    const { db } = await getSystemDb(agentId)
    const day = sql<string>`substr(${runs.startedAt}, 1, 10)`
    const conditions = [eq(runs.agentId, agentId), eq(runs.status, 'done')]
    if (sinceIso) conditions.push(gte(runs.startedAt, sinceIso))
    return db
        .select({
            day,
            model: runs.model,
            inputTokens: sql<number>`coalesce(sum(${runs.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${runs.outputTokens}), 0)`,
            cachedInputTokens: sql<number>`coalesce(sum(${runs.cachedInputTokens}), 0)`,
            reasoningTokens: sql<number>`coalesce(sum(${runs.reasoningTokens}), 0)`,
            totalTokens: sql<number>`coalesce(sum(${runs.totalTokens}), 0)`,
            costMicros: sql<number>`coalesce(sum(${runs.costMicros}), 0)`,
            runCount: sql<number>`count(*)`,
        })
        .from(runs)
        .where(and(...conditions))
        .groupBy(day, runs.model)
        .orderBy(day)
}

export async function getRun(agentId: string, id: string): Promise<RunRow | undefined> {
    const { db } = await getSystemDb(agentId)
    const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1)
    return rows[0]
}

export type RunFilter = { limit?: number; sessionId?: string; status?: string }

export async function listRunsByAgent(agentId: string, { limit = 50, sessionId, status }: RunFilter = {}): Promise<RunRow[]> {
    const { db } = await getSystemDb(agentId)
    const conditions = [eq(runs.agentId, agentId)]
    if (sessionId) conditions.push(eq(runs.sessionId, sessionId))
    if (status) conditions.push(eq(runs.status, status))
    return db
        .select()
        .from(runs)
        .where(and(...conditions))
        .orderBy(desc(runs.startedAt))
        .limit(limit)
}

export async function startRun(agentId: string, sessionId: string, id: string = newId()): Promise<RunRow> {
    const row: RunRow = {
        id,
        agentId,
        sessionId,
        status: 'running',
        stepCount: 0,
        usageJson: null,
        provider: null,
        model: null,
        triggerSource: null,
        triggerSlug: null,
        costMicros: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        startedAt: nowIso(),
        finishedAt: null,
        error: null,
        executionStartRevision: null,
        executionTerminalIntent: false,
        executionTerminalAttention: null,
    }
    const { db } = await getSystemDb(agentId)
    return db.transaction(async tx => {
        await tx.insert(runs).values(row)
        const [head] = await tx.insert(sessionExecutionHeads).values({ sessionId, runId: id, revision: 1, state: 'working', attentionKind: null, attentionRevision: null })
            .onConflictDoUpdate({
                target: sessionExecutionHeads.sessionId,
                set: { runId: id, revision: sql`${sessionExecutionHeads.revision} + 1`, state: 'working', attentionKind: null, attentionRevision: null, deliveryAttempts: 0, deliveryNextAttemptAt: 0 },
                setWhere: lt(sessionExecutionHeads.revision, Number.MAX_SAFE_INTEGER),
            }).returning({ revision: sessionExecutionHeads.revision })
        if (!head) throw new Error('session execution revision exhausted')
        await tx.update(runs).set({ executionStartRevision: head.revision }).where(eq(runs.id, id))
        return { ...row, executionStartRevision: head.revision }
    })
}

export type RunContextPatch = { provider: string; model: string; triggerSource: string; triggerSlug: string | null }

export async function setRunContext(agentId: string, id: string, patch: RunContextPatch): Promise<void> {
    const { db } = await getSystemDb(agentId)
    await db.update(runs).set(patch).where(eq(runs.id, id))
}

export async function bumpRunStep(agentId: string, id: string, stepCount: number): Promise<void> {
    const { db } = await getSystemDb(agentId)
    await db.update(runs).set({ stepCount }).where(eq(runs.id, id))
}

type UsageTokens = { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number }

export async function finishRun(agentId: string, id: string, usage: UsageTokens | null | undefined, stepCount: number, costMicros: number | null = null, context?: ContextOccupancy, attention?: AttentionKind): Promise<boolean> {
    const { db } = await getSystemDb(agentId)
    const finished = await db.update(runs).set({
        status: 'done',
        finishedAt: nowIso(),
        usageJson: JSON.stringify(context ? { ...usage, context } : (usage ?? null)),
        stepCount,
        costMicros,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        executionTerminalIntent: true,
        executionTerminalAttention: attention ?? null,
    }).where(and(eq(runs.id, id), eq(runs.agentId, agentId), eq(runs.status, 'running'))).returning({ id: runs.id })
    return finished.length > 0
}

export async function failRun(agentId: string, id: string, error: string): Promise<boolean> {
    const { db } = await getSystemDb(agentId)
    const failed = await db.update(runs).set({ status: 'error', finishedAt: nowIso(), error, executionTerminalIntent: true, executionTerminalAttention: null })
        .where(and(eq(runs.id, id), eq(runs.agentId, agentId), eq(runs.status, 'running')))
        .returning({ id: runs.id })
    return failed.length > 0
}

export async function cancelRun(agentId: string, id: string): Promise<boolean> {
    const { db } = await getSystemDb(agentId)
    const cancelled = await db.update(runs)
        .set({ status: 'cancelled', finishedAt: nowIso(), executionTerminalIntent: true, executionTerminalAttention: null })
        .where(and(eq(runs.id, id), eq(runs.agentId, agentId), eq(runs.status, 'running')))
        .returning({ id: runs.id })
    return cancelled.length > 0
}

export type InterruptedRun = { id: string; sessionId: string; triggerSource: string | null; triggerSlug: string | null; startedAt: string }

// Returns the rows it repaired rather than a count: a run interrupted mid-flight also left a
// conversation stuck on the hub, and only these ids can tell it the run is over.
export async function failInterruptedRuns(agentId: string): Promise<InterruptedRun[]> {
    const { db } = await getSystemDb(agentId)
    const stale = await db
        .select({ id: runs.id, sessionId: runs.sessionId, triggerSource: runs.triggerSource, triggerSlug: runs.triggerSlug, startedAt: runs.startedAt })
        .from(runs)
        .where(eq(runs.status, 'running'))
    if (stale.length === 0) return []
    await db.update(runs).set({ status: 'error', finishedAt: nowIso(), error: 'interrupted: engine restarted', executionTerminalIntent: true, executionTerminalAttention: null }).where(eq(runs.status, 'running'))
    return stale
}
