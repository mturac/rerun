import { callableEngineAgentIds } from '@/app/api/_auth/access'
import { createSessionRow, ensureSessionRow, getAgentChatTarget, getExistingSession, projectChatAdmission } from '@/app/api/_services/chat.service'
import { recordSessionParticipant, recordSessionRead } from '@/app/api/_services/notification-audience.service'
import { buildInstallMessage } from '@/lib/chat/install-marker'
import * as engine from '@/lib/engine/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: vi.fn().mockResolvedValue({ userId: 'me', workspace: { id: 7 }, authUser: { app_metadata: {}, user_metadata: {} } }) }))
vi.mock('@/app/api/_auth/access', () => ({ actorFromContext: vi.fn(() => ({ kind: 'user', userId: 'me', workspaceId: 7, role: 'member', boxScope: 'assigned' })), callableEngineAgentIds: vi.fn() }))
vi.mock('@/app/api/_services/notification-audience.service', () => ({ recordSessionParticipant: vi.fn(), recordSessionRead: vi.fn() }))
vi.mock('@/app/api/_services/chat.service', () => ({
    getAgentChatTarget: vi.fn(),
    getExistingSession: vi.fn(),
    createSessionRow: vi.fn(),
    ensureSessionRow: vi.fn(),
    projectChatAdmission: vi.fn(),
}))
vi.mock('@/lib/ai/generate-title', () => ({ generateSessionTitle: vi.fn().mockResolvedValue('Title') }))
vi.mock('@/supabase/serviceRole', () => ({ createServiceRoleClient: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ chat: vi.fn(), reconnectRun: vi.fn() }))

const busy = (authorId: string | null = 'me') => Response.json({ code: 'run_in_flight', runId: 'run-1', startedAt: null, authorId }, { status: 409 })
const streaming = (runId: string) => new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-run-id': runId, 'x-session-id': 'engine-session' } })

function request(body: Record<string, unknown>, signal?: AbortSignal) {
    return new Request('https://rerun.test/api/chat', { method: 'POST', signal, body: JSON.stringify({ agentId: 'agent', sessionId: 'session', text: 'ship it', ...body }) })
}

// The route sleeps between retries; without fake timers the queued cases would take 25 seconds.
async function settle(response: Promise<Response>): Promise<Response> {
    await vi.runAllTimersAsync()
    return response
}

describe('POST /api/chat', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(engine.chat).mockReset()
        vi.useFakeTimers()
        vi.mocked(getAgentChatTarget).mockResolvedValue({ engineAgentId: 'engine-agent', conn: { baseUrl: 'https://engine.test', apiKey: null }, contentLocked: false })
        vi.mocked(getExistingSession).mockResolvedValue({ sessionId: 'session', agentId: 'agent', engineSessionId: 'engine-session' })
        vi.mocked(callableEngineAgentIds).mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('hands a queued message back rather than tailing the run holding the conversation', async () => {
        vi.mocked(engine.chat).mockImplementation(async () => busy())

        const response = await settle(POST(request({ queued: true })))

        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: 'run_in_flight', runId: 'run-1' })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
        expect(vi.mocked(engine.chat).mock.calls.length).toBeGreaterThan(1)
    })

    it('sends a queued message as soon as the engine releases the session', async () => {
        vi.mocked(engine.chat).mockImplementationOnce(async () => busy()).mockImplementationOnce(async () => streaming('run-2'))

        const response = await settle(POST(request({ queued: true })))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-2')
        expect(engine.chat).toHaveBeenCalledTimes(2)
    })

    it('does not retry a queued send after its client request is aborted', async () => {
        const controller = new AbortController()
        vi.mocked(engine.chat).mockImplementationOnce(async () => {
            controller.abort()
            return busy()
        }).mockImplementationOnce(async () => streaming('unwanted-run'))

        const response = await settle(POST(request({ queued: true }, controller.signal)))

        expect(response.status).toBe(502)
        expect(response.headers.get('X-Run-Id')).toBeNull()
        expect(engine.chat).toHaveBeenCalledTimes(1)
        expect(projectChatAdmission).not.toHaveBeenCalled()
    })

    it('still returns admission already acknowledged when the client request is aborted', async () => {
        const controller = new AbortController()
        vi.mocked(engine.chat).mockImplementation(async () => {
            controller.abort()
            return streaming('accepted-run')
        })

        const response = await settle(POST(request({}, controller.signal)))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('accepted-run')
        expect(projectChatAdmission).toHaveBeenCalledWith(7, 'agent', 'engine-agent', 'engine-session', expect.any(Response))
    })

    it.each(['Send the invoice', 'Cancel the delivery'])('hands back a different same-author message (%s) without tailing the earlier answer', async text => {
        vi.mocked(engine.chat).mockImplementation(async () => busy())
        vi.mocked(engine.reconnectRun).mockResolvedValue(streaming('run-1'))

        const response = await settle(POST(request({ text })))

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'run_in_flight', runId: 'run-1', startedAt: null, heldByTeammate: false })
        expect(response.headers.get('X-Run-Id')).toBeNull()
        expect(engine.chat).toHaveBeenCalledTimes(1)
        expect(vi.mocked(engine.chat).mock.calls[0][2]).toMatchObject({ message: text, author: { id: 'me' } })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
        expect(createSessionRow).not.toHaveBeenCalled()
        expect(projectChatAdmission).not.toHaveBeenCalled()
        expect(recordSessionParticipant).not.toHaveBeenCalled()
        expect(recordSessionRead).not.toHaveBeenCalled()
    })

    it.each([null, 'teammate'])('keeps busy messages recoverable when the run author is %s', async authorId => {
        vi.mocked(engine.chat).mockImplementation(async () => busy(authorId))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'run_in_flight', runId: 'run-1', startedAt: null, heldByTeammate: authorId === 'teammate' })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
    })

    it('keeps a busy response usable when the engine supplies no run metadata', async () => {
        vi.mocked(engine.chat).mockResolvedValue(new Response('busy', { status: 409 }))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'run_in_flight', runId: null, startedAt: null, heldByTeammate: false })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
    })

    it('still opens an installation already running in another conversation', async () => {
        vi.mocked(engine.chat).mockResolvedValue(Response.json({ code: 'install_in_flight', sessionId: 'engine-install' }, { status: 409 }))
        vi.mocked(ensureSessionRow).mockResolvedValue('install-session')

        const response = await settle(POST(request({ sessionId: undefined, text: buildInstallMessage('Install the calendar', 'Calendar'), source: 'dashboard' })))

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'install_in_flight', sessionId: 'install-session' })
        expect(ensureSessionRow).toHaveBeenCalledWith('agent', 'engine-install', 'Install Calendar', { source: 'dashboard' })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
    })

    it('hands the engine the coworkers the author reaches', async () => {
        vi.mocked(callableEngineAgentIds).mockResolvedValue(['engine-agent', 'engine-other'])
        vi.mocked(engine.chat).mockImplementation(async () => streaming('run-3'))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Session-Id')).toBe('session')
        expect(response.headers.get('X-Run-Id')).toBe('run-3')
        expect(await response.text()).toBe('data: {}\n\n')
        expect(vi.mocked(engine.chat).mock.calls[0][2]).toMatchObject({ callableAgentIds: ['engine-agent', 'engine-other'] })
        expect(projectChatAdmission).toHaveBeenCalledWith(7, 'agent', 'engine-agent', 'engine-session', expect.any(Response))
        expect(recordSessionParticipant).toHaveBeenCalledWith('session', 'me')
        expect(recordSessionRead).toHaveBeenCalledWith('session', 'me')
    })

    it('refuses the send when what the author reaches cannot be read, rather than opening every coworker', async () => {
        vi.mocked(callableEngineAgentIds).mockRejectedValue(new Error('database down'))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(502)
        expect(engine.chat).not.toHaveBeenCalled()
    })

    it('refuses a conversation of another coworker without reaching the engine', async () => {
        vi.mocked(getExistingSession).mockResolvedValue({ sessionId: 'session', agentId: 'other-agent', engineSessionId: 'other-engine-session' })

        const response = await settle(POST(request({})))

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'session_not_found' })
        expect(engine.chat).not.toHaveBeenCalled()
    })

    it('answers the engine refusing a session it does not hold with the same code, not its raw text', async () => {
        vi.mocked(engine.chat).mockResolvedValue(Response.json({ error: 'session not found for this agent' }, { status: 404 }))

        const response = await settle(POST(request({})))

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'session_not_found' })
    })
})
