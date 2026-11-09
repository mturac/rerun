import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-execution-repo-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it } = await import('vitest')
const { eq } = await import('drizzle-orm')
const { createSession } = await import('./sessions.js')
const { startRun, getRun, finishRun, cancelRun } = await import('./runs.js')
const { advanceExecution, getSessionExecution } = await import('./execution.js')
const { closeSystemDb, getSystemDb } = await import('../systemDb.js')
const { runs, sessionExecutionHeads } = await import('../schema.js')
const { recoverSessionExecutions } = await import('../../runtime/execution-recovery.js')

const agent = 'execution-repo'

describe('execution owner and attention', () => {
    it('commits a durable pending delivery with admission and terminal state, including after reopening', async () => {
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        const pending = async () => {
            const { client } = await getSystemDb(agent)
            return (await client.execute({ sql: 'SELECT revision, delivery_ack_revision FROM session_execution_heads WHERE session_id = ?', args: [session.id] })).rows[0]
        }
        expect(await pending()).toMatchObject({ revision: 1, delivery_ack_revision: 0 })
        await advanceExecution(agent, session.id, run.id, { kind: 'terminal', state: 'idle' })
        closeSystemDb(agent)
        expect(await pending()).toMatchObject({ revision: 2, delivery_ack_revision: 0 })
    })
    it('retains the same attention watermark through a successful terminal transition', async () => {
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        const attention = await advanceExecution(agent, session.id, run.id, { kind: 'attention', attention: 'ack' })
        const terminal = await advanceExecution(agent, session.id, run.id, { kind: 'terminal', state: 'idle' })
        expect(attention).toMatchObject({ revision: 2, state: 'working', attention: { kind: 'ack', revision: 2 } })
        expect(terminal).toMatchObject({ revision: 3, state: 'idle', attention: { kind: 'ack', revision: 2 } })
    })

    it('replaces attention with a fresh HITL watermark and clears it on an error', async () => {
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        await advanceExecution(agent, session.id, run.id, { kind: 'attention', attention: 'ack' })
        expect(await advanceExecution(agent, session.id, run.id, { kind: 'terminal', state: 'idle', attention: 'question' })).toMatchObject({ revision: 3, state: 'idle', attention: { kind: 'question', revision: 3 } })
        expect(await advanceExecution(agent, session.id, run.id, { kind: 'terminal', state: 'error' })).toMatchObject({ revision: 4, state: 'error', attention: null })
    })

    it('rejects an old terminal owner and starts the new owner without old attention', async () => {
        const session = await createSession(agent)
        const first = await startRun(agent, session.id)
        await advanceExecution(agent, session.id, first.id, { kind: 'attention', attention: 'ack' })
        const second = await startRun(agent, session.id)
        expect(await advanceExecution(agent, session.id, first.id, { kind: 'terminal', state: 'idle' })).toBeNull()
        expect(await getSessionExecution(agent, session.id)).toMatchObject({ runId: second.id, revision: 3, state: 'working', attention: null })
    })

    it('rolls back the head and run together when a duplicate run insert fails', async () => {
        const session = await createSession(agent)
        const first = await startRun(agent, session.id)
        const second = await startRun(agent, session.id)
        await expect(startRun(agent, session.id, first.id)).rejects.toThrow()
        expect(await getSessionExecution(agent, session.id)).toMatchObject({ runId: second.id, revision: 2 })
    })

    it('refuses revision overflow without leaving an accepted run behind', async () => {
        const session = await createSession(agent)
        await startRun(agent, session.id)
        const { db } = await getSystemDb(agent)
        await db.update(sessionExecutionHeads).set({ revision: Number.MAX_SAFE_INTEGER }).where(eq(sessionExecutionHeads.sessionId, session.id))
        await expect(startRun(agent, session.id, 'overflow-run')).rejects.toThrow('revision exhausted')
        expect(await getRun(agent, 'overflow-run')).toBeUndefined()
        expect((await getSessionExecution(agent, session.id))?.revision).toBe(Number.MAX_SAFE_INTEGER)
    })
})

describe('execution restart recovery', () => {
    it('uses the durable terminal intent after a crash between the run commit and head finalization', async () => {
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        await finishRun(agent, run.id, null, 1, null, undefined, 'question')
        closeSystemDb(agent)
        expect(await getSessionExecution(agent, session.id)).toMatchObject({ state: 'working', revision: 1 })
        const recovered = await recoverSessionExecutions(agent)
        expect(recovered.find(item => item.execution.sessionId === session.id)).toMatchObject({ needsReview: false, execution: { runId: run.id, state: 'idle', revision: 2, attention: { kind: 'question', revision: 2 } } })
        expect(await recoverSessionExecutions(agent)).not.toContainEqual(expect.objectContaining({ execution: expect.objectContaining({ sessionId: session.id }) }))
    })

    it('keeps acknowledgement attention when a cancelled run is repaired', async () => {
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        await advanceExecution(agent, session.id, run.id, { kind: 'attention', attention: 'ack' })
        await cancelRun(agent, run.id)
        await recoverSessionExecutions(agent)
        expect(await getSessionExecution(agent, session.id)).toMatchObject({ state: 'idle', attention: { kind: 'ack', revision: 2 } })
    })

    it('does not invent an idle state for a terminal commit without known intent', async () => {
        const session = await createSession(agent)
        const run = await startRun(agent, session.id)
        await finishRun(agent, run.id, null, 0)
        const { db } = await getSystemDb(agent)
        await db.update(runs).set({ executionTerminalIntent: false }).where(eq(runs.id, run.id))
        const recovered = await recoverSessionExecutions(agent)
        expect(recovered.find(item => item.execution.sessionId === session.id)).toMatchObject({ needsReview: true, execution: { state: 'error', attention: null } })
    })
})
