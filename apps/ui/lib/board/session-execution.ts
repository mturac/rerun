import { z } from 'zod'
import type { SessionStatus } from './types'

export const sessionObservationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('execution'), runId: z.string().min(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), attentionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), projectionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
    z.object({ kind: z.literal('legacy'), updatedAt: z.string().min(1) }),
])
export type SessionObservation = z.infer<typeof sessionObservationSchema>
export type SessionProjection = { sessionId: string; status: SessionStatus; observation: SessionObservation | null }

type ProjectionRow = { engine_run_id?: string | null; execution_revision?: number; execution_attention_revision?: number | null; execution_projection_version?: number; updated_at?: string | null }

export function sessionObservationOf(row: ProjectionRow): SessionObservation | null {
    if (row.engine_run_id && row.execution_revision && row.execution_projection_version) {
        return { kind: 'execution', runId: row.engine_run_id, revision: row.execution_revision, attentionRevision: row.execution_attention_revision ?? null, projectionVersion: row.execution_projection_version }
    }
    return row.updated_at ? { kind: 'legacy', updatedAt: row.updated_at } : null
}

export function sameSessionObservation(a: SessionObservation | null | undefined, b: SessionObservation | null | undefined): boolean {
    if (!a || !b) return a === b
    if (a.kind !== b.kind) return false
    if (a.kind === 'legacy') return b.kind === 'legacy' && a.updatedAt === b.updatedAt
    return b.kind === 'execution' && a.runId === b.runId && a.revision === b.revision && a.attentionRevision === b.attentionRevision && a.projectionVersion === b.projectionVersion
}

export function acceptsSessionObservation(current: SessionObservation | null | undefined, incoming: SessionObservation | null | undefined): boolean {
    if (current?.kind !== 'execution') return true
    return incoming?.kind === 'execution' && incoming.projectionVersion >= current.projectionVersion
}
