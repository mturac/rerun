import { describe, expect, it } from 'vitest'
import { acceptsSessionObservation, sameSessionObservation, sessionObservationOf } from './session-execution'

const head = { kind: 'execution' as const, runId: 'b', revision: 4, attentionRevision: 4, projectionVersion: 8 }
describe('session execution observations', () => {
    it('rejects old engine snapshots and old ACK responses even within the same engine revision', () => {
        expect(acceptsSessionObservation(head, { ...head, projectionVersion: 7 })).toBe(false)
        expect(acceptsSessionObservation(head, { ...head, projectionVersion: 9 })).toBe(true)
        expect(acceptsSessionObservation(head, { kind: 'legacy', updatedAt: 'later' })).toBe(false)
        expect(acceptsSessionObservation(head, null)).toBe(false)
    })
    it('admits the first fenced observation and retains the hub ACK version', () => {
        expect(acceptsSessionObservation(null, head)).toBe(true)
        expect(sessionObservationOf({ engine_run_id: 'b', execution_revision: 4, execution_projection_version: 8, execution_attention_revision: 4 })).toEqual(head)
        expect(sameSessionObservation(head, { ...head, projectionVersion: 9 })).toBe(false)
    })
    it('represents legacy rows explicitly and refuses to invent a fence for incomplete rows', () => {
        expect(sessionObservationOf({ updated_at: 'before' })).toEqual({ kind: 'legacy', updatedAt: 'before' })
        expect(sessionObservationOf({ engine_run_id: 'b', execution_revision: 4 })).toBeNull()
    })
})
