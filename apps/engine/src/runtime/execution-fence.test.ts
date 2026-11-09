import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-execution-fence-'))
process.env.RERUN_API_KEY = 'execution-test-token'
process.env.RERUN_HUB_BASE_URL = 'https://hub.test'

const { afterEach, beforeAll, describe, expect, it, vi } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir } = await import('../config/paths.js')
const { createSession } = await import('../db/repos/sessions.js')
const { startRun, getRun } = await import('../db/repos/runs.js')
const { closeSystemDb } = await import('../db/systemDb.js')
const { createServer } = await import('../http/server.js')
const { sendNotification } = await import('./notify.js')
const { emitRunTerminal } = await import('./run-events.js')
const { advanceExecution } = await import('../db/repos/execution.js')
const { setEnv } = await import('../config/env.js')

const id = 'fenced-agent'
const app = createServer()
const originalFetch = globalThis.fetch
const headers = { Authorization: 'Bearer execution-test-token' }

beforeAll(async () => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'Fence tests' }))
})

afterEach(() => {
    globalThis.fetch = originalFetch
    setEnv({ RERUN_HUB_BASE_URL: 'https://hub.test' })
})

async function execution(sessionId: string) {
    const response = await app.request(`/agents/${id}/sessions/${sessionId}/execution`, { headers })
    expect(response.status).toBe(200)
    return (await response.json()) as { execution: Record<string, unknown> | null }
}

describe('session execution ordering', () => {
    it('records local attention even when webhook delivery is not configured', async () => {
        const session = await createSession(id)
        const run = await startRun(id, session.id)
        setEnv({ RERUN_HUB_BASE_URL: '' })
        const fetchMock = vi.fn()
        globalThis.fetch = fetchMock
        expect(await sendNotification({ kind: 'info', agentId: id, sessionId: session.id, runId: run.id, message: 'Review locally' })).toEqual({ delivered: false, reason: 'webhook not configured' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await execution(session.id)).toMatchObject({ execution: { revision: 2, attention: { kind: 'ack', revision: 2 } } })
    })
    it('persists the admission revision on the accepted run', async () => {
        const session = await createSession(id)
        const run = await startRun(id, session.id)
        expect(run).toMatchObject({ executionStartRevision: 1 })
        expect(await getRun(id, run.id)).toMatchObject({ executionStartRevision: 1 })
    })

    it('exposes a current execution snapshot and keeps its order after reopening the DB', async () => {
        const session = await createSession(id)
        const first = await startRun(id, session.id)
        const second = await startRun(id, session.id)
        closeSystemDb(id)
        expect(await execution(session.id)).toEqual({ execution: { agentId: id, sessionId: session.id, runId: second.id, revision: 2, state: 'working', attention: null } })
        expect((await getRun(id, first.id))?.id).toBe(first.id)
    })

    it('carries a fresh attention revision so terminal delivery can preserve an unseen notice', async () => {
        const session = await createSession(id)
        const run = await startRun(id, session.id)
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }))
        globalThis.fetch = fetchMock
        await sendNotification({ kind: 'info', agentId: id, sessionId: session.id, runId: run.id, message: 'Please review this result.' })
        const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        expect(payload.execution).toEqual({ agentId: id, sessionId: session.id, runId: run.id, revision: 2, state: 'working', attention: { kind: 'ack', revision: 2 } })
    })

    it('does not let an old run allocate attention after the session has a new owner', async () => {
        const session = await createSession(id)
        const first = await startRun(id, session.id)
        const second = await startRun(id, session.id)
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }))
        globalThis.fetch = fetchMock
        await sendNotification({ kind: 'info', agentId: id, sessionId: session.id, runId: first.id, message: 'A late old notice' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await execution(session.id)).toEqual({ execution: { agentId: id, sessionId: session.id, runId: second.id, revision: 2, state: 'working', attention: null } })
    })

    it('returns no execution for a session that never accepted a run', async () => {
        const session = await createSession(id)
        expect(await execution(session.id)).toEqual({ execution: null })
        expect((await app.request(`/agents/${id}/sessions/missing/execution`, { headers })).status).toBe(404)
    })

    it('suppresses a reserved old terminal when a new run already owns the session', async () => {
        const session = await createSession(id)
        const first = await startRun(id, session.id)
        const terminal = await advanceExecution(id, session.id, first.id, { kind: 'terminal', state: 'idle' })
        const second = await startRun(id, session.id)
        const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }))
        globalThis.fetch = fetchMock
        await emitRunTerminal({ agentId: id, sessionId: session.id, runId: first.id, trigger: { source: 'chat' }, kind: 'done', execution: terminal })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await execution(session.id)).toMatchObject({ execution: { runId: second.id, revision: 3, state: 'working' } })
    })
})
