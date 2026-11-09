import { callableEngineAgentIds } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { messageAuthorOf } from '@/app/api/_services/me.service'
import { getWorkspaceConnection } from '@/app/api/_services/workspace-engine.service'
import * as engine from '@/lib/engine/client'
import type { EngineRunDetail } from '@/lib/engine/types'
import { isPhoneStepPending } from '@rerun/cloud/phone.server'
import { cancelForemanSessionRuns, engineSessionOf, loadForemanConversation, startEngineConversation, touchForemanConversation } from '@/lib/foreman/conversation'
import { loadForemanState } from '@/lib/foreman/state'
import { resolveForemanSurface } from '@/lib/foreman/surface.server'
import { PHONE_REQUIRED_MESSAGE } from '@rerun/cloud/phone'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE, GET, POST } from './route'

vi.mock('@/app/api/_auth/ownership', () => ({ requireWorkspaceContext: vi.fn() }))
vi.mock('@/app/api/_auth/access', () => ({ actorFromContext: vi.fn(() => ({ kind: 'user', userId: 'user-1', workspaceId: 7, role: 'member', boxScope: 'assigned' })), callableEngineAgentIds: vi.fn() }))
vi.mock('@/lib/foreman/hub-token', () => ({ mintForemanHubToken: vi.fn(() => null) }))
vi.mock('@rerun/cloud/phone.server', () => ({ isPhoneStepPending: vi.fn() }))
vi.mock('@/app/api/_services/me.service', () => ({ messageAuthorOf: vi.fn() }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ getWorkspaceConnection: vi.fn(), NoEngineError: class NoEngineError extends Error {} }))
vi.mock('@/lib/engine/client', () => ({ chat: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn(), reconnectRun: vi.fn() }))
vi.mock('@/lib/foreman/conversation', () => ({
    cancelForemanSessionRuns: vi.fn(),
    engineSessionOf: vi.fn().mockResolvedValue(null),
    loadForemanConversation: vi.fn(),
    readForemanEngineMessages: vi.fn(),
    startEngineConversation: vi.fn(),
    touchForemanConversation: vi.fn(),
}))
vi.mock('@/lib/foreman/engine-brief', () => ({ foremanEngineBrief: vi.fn() }))
vi.mock('@/lib/foreman/state', () => ({ loadForemanState: vi.fn() }))
vi.mock('@/lib/foreman/surface.server', () => ({ resolveForemanSurface: vi.fn() }))

const URL = 'https://rerun.test/api/chat/foreman/engine'
const post = (body: Record<string, unknown> = {}, signal?: AbortSignal) => new Request(URL, { method: 'POST', signal, body: JSON.stringify({ sessionId: 'session', text: 'ship it', ...body }) })
const busy = () => Response.json({ code: 'run_in_flight', runId: 'run-1', startedAt: null, authorId: 'user-1' }, { status: 409 })
const streaming = (runId: string) => new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'x-run-id': runId, 'x-session-id': 'engine-session' } })
const run: EngineRunDetail = {
    id: 'run-1', agentId: 'foreman', sessionId: 'engine-session', status: 'running', stepCount: 1,
    usageJson: null, provider: null, model: null, triggerSource: null, triggerSlug: null,
    costMicros: null, inputTokens: null, outputTokens: null, cachedInputTokens: null,
    reasoningTokens: null, totalTokens: null, startedAt: '2026-11-08T12:00:00Z', finishedAt: null, error: null,
}

const stop = (params: Record<string, string>) => new Request(`${URL}?${new URLSearchParams(params)}`, { method: 'DELETE' })

async function settle(response: Promise<Response>): Promise<Response> {
    await vi.runAllTimersAsync()
    return response
}

describe('/api/chat/foreman/engine', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(engine.chat).mockReset()
        vi.useFakeTimers()
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ userId: 'user-1', authUser: { is_anonymous: false }, workspace: { id: 7 }, supabase: {} } as never)
        vi.mocked(messageAuthorOf).mockReturnValue({ id: 'user-1' })
        vi.mocked(isPhoneStepPending).mockResolvedValue(false)
        vi.mocked(engineSessionOf).mockResolvedValue(null)
        vi.mocked(loadForemanState).mockResolvedValue({ phase: 'onboarding' } as never)
        vi.mocked(resolveForemanSurface).mockResolvedValue('hub' as never)
        vi.mocked(getWorkspaceConnection).mockResolvedValue({ baseUrl: 'https://engine.test', apiKey: null })
        vi.mocked(callableEngineAgentIds).mockResolvedValue(undefined)
        vi.mocked(engine.getRun).mockResolvedValue(run)
        vi.mocked(engine.cancelRun).mockResolvedValue(undefined)
        vi.mocked(cancelForemanSessionRuns).mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('turns away a message from an account that still owes its phone number', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(true)

        const response = await POST(post())

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: PHONE_REQUIRED_MESSAGE })
        expect(loadForemanState).not.toHaveBeenCalled()
    })

    it('lets a message from an account that owes nothing through', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(false)

        const response = await POST(post())

        expect(response.status).toBe(409)
        expect(loadForemanState).toHaveBeenCalledOnce()
    })

    it('still reopens the conversation of an account that owes its phone number', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(true)
        vi.mocked(loadForemanConversation).mockResolvedValue(null)

        const response = await GET(new Request(URL))

        expect(response.status).toBe(200)
        expect(isPhoneStepPending).not.toHaveBeenCalled()
    })

    it('hands the engine the coworkers the member reaches, so call_agent names no other', async () => {
        vi.mocked(isPhoneStepPending).mockResolvedValue(false)
        vi.mocked(resolveForemanSurface).mockResolvedValue('engine' as never)
        vi.mocked(getWorkspaceConnection).mockResolvedValue({ baseUrl: 'https://engine.test', apiKey: null } as never)
        vi.mocked(callableEngineAgentIds).mockResolvedValue(['engine-open'])
        vi.mocked(engine.chat).mockResolvedValue(new Response('', { status: 500 }))

        await POST(post())

        expect(vi.mocked(engine.chat).mock.calls[0][2]).toMatchObject({ callableAgentIds: ['engine-open'] })
    })

    it.each(['Send the invoice', 'Cancel the delivery'])('hands back a different same-author message (%s) without tailing the earlier answer', async text => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.chat).mockImplementation(async () => busy())
        vi.mocked(engine.reconnectRun).mockResolvedValue(streaming('run-1'))

        const response = await settle(POST(post({ text })))

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'run_in_flight', runId: 'run-1', startedAt: null })
        expect(response.headers.get('X-Run-Id')).toBeNull()
        expect(engine.chat).toHaveBeenCalledTimes(1)
        expect(vi.mocked(engine.chat).mock.calls[0][2]).toMatchObject({ message: text, author: { id: 'user-1' } })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
        expect(startEngineConversation).not.toHaveBeenCalled()
        expect(touchForemanConversation).not.toHaveBeenCalled()
    })

    it('hands an exhausted queued send back without consuming an unrelated stream', async () => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.chat).mockImplementation(async () => busy())

        const response = await settle(POST(post({ queued: true })))

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'run_in_flight', runId: 'run-1', startedAt: null })
        expect(vi.mocked(engine.chat).mock.calls.length).toBeGreaterThan(1)
        expect(engine.reconnectRun).not.toHaveBeenCalled()
    })

    it('does not retry a queued send after its client request is aborted', async () => {
        const controller = new AbortController()
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.chat).mockImplementationOnce(async () => {
            controller.abort()
            return busy()
        }).mockImplementationOnce(async () => streaming('unwanted-run'))

        const response = await settle(POST(post({ queued: true }, controller.signal)))

        expect(response.status).toBe(502)
        expect(response.headers.get('X-Run-Id')).toBeNull()
        expect(engine.chat).toHaveBeenCalledTimes(1)
        expect(touchForemanConversation).not.toHaveBeenCalled()
    })

    it('preserves acknowledgement already returned by the engine when the client aborts', async () => {
        const controller = new AbortController()
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.chat).mockImplementation(async () => {
            controller.abort()
            return streaming('accepted-run')
        })

        const response = await settle(POST(post({}, controller.signal)))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('accepted-run')
        expect(touchForemanConversation).toHaveBeenCalledWith('session')
    })

    it('retries a queued send and streams its own run when the conversation is free', async () => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.chat).mockImplementationOnce(async () => busy()).mockImplementationOnce(async () => streaming('run-2'))

        const response = await settle(POST(post({ queued: true })))

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-2')
        expect(await response.text()).toBe('data: {}\n\n')
        expect(engine.chat).toHaveBeenCalledTimes(2)
        expect(touchForemanConversation).toHaveBeenCalledWith('session')
        expect(startEngineConversation).not.toHaveBeenCalled()
    })

    it('persists a newly started conversation before returning its stream', async () => {
        vi.mocked(resolveForemanSurface).mockResolvedValue('engine' as never)
        vi.mocked(engine.chat).mockResolvedValue(streaming('run-3'))

        const response = await POST(post())

        expect(response.status).toBe(200)
        expect(response.headers.get('X-Run-Id')).toBe('run-3')
        expect(await response.text()).toBe('data: {}\n\n')
        expect(startEngineConversation).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', workspace: { id: 7 } }), 'session', 'engine-session', 'ship it')
        expect(touchForemanConversation).not.toHaveBeenCalled()
    })

    it('keeps a busy response usable without engine run metadata', async () => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.chat).mockResolvedValue(new Response('busy', { status: 409 }))

        const response = await POST(post())

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'run_in_flight', runId: null, startedAt: null })
        expect(engine.reconnectRun).not.toHaveBeenCalled()
    })

    it('rejects anonymous callers before reaching the engine', async () => {
        vi.mocked(requireWorkspaceContext).mockResolvedValue({ authUser: { is_anonymous: true } } as never)

        const response = await POST(post())

        expect(response.status).toBe(401)
        expect(engine.chat).not.toHaveBeenCalled()
    })

    it('stops only the requested run when another starts before cancellation returns', async () => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        let activeRun = 'run-1'
        let releaseCancel: () => void = () => {}
        const stopped: string[] = []
        const cancellationStarted = new Promise<void>(started => {
            vi.mocked(engine.cancelRun).mockImplementation(async (_conn, _agentId, runId) => {
                stopped.push(runId)
                if (runId === 'run-1') {
                    started()
                    await new Promise<void>(resolve => { releaseCancel = resolve })
                }
            })
        })
        vi.mocked(cancelForemanSessionRuns).mockImplementation(async () => {
            await engine.cancelRun({ baseUrl: 'https://engine.test', apiKey: null }, 'foreman', activeRun)
        })

        const responsePromise = DELETE(stop({ runId: 'run-1', sessionId: 'session' }))
        await cancellationStarted
        activeRun = 'run-2'
        releaseCancel()
        const response = await responsePromise

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(stopped).toEqual(['run-1'])
    })

    it.each(['done', 'cancelled'] as const)('keeps a targeted stop on its run when lookup reports %s', async status => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.getRun).mockResolvedValue({ ...run, status })

        const response = await DELETE(stop({ runId: 'run-1', sessionId: 'session' }))

        expect(response.status).toBe(200)
        expect(engine.cancelRun).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://engine.test', apiKey: null }, 'foreman', 'run-1')
        expect(cancelForemanSessionRuns).not.toHaveBeenCalled()
    })

    it('rejects a run belonging to a different engine conversation', async () => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'other-engine-session' })

        const response = await DELETE(stop({ runId: 'run-1', sessionId: 'session' }))

        expect(response.status).toBe(404)
        expect(engine.cancelRun).not.toHaveBeenCalled()
        expect(cancelForemanSessionRuns).not.toHaveBeenCalled()
    })

    it.each([null, { backend: 'hub', engineSessionId: null }, { backend: 'engine', engineSessionId: null }] as const)('rejects a targeted stop without an owned engine conversation (%j)', async session => {
        vi.mocked(engineSessionOf).mockResolvedValue(session)

        const response = await DELETE(stop({ runId: 'run-1', sessionId: 'session' }))

        expect(response.status).toBe(404)
        expect(engine.getRun).not.toHaveBeenCalled()
        expect(engine.cancelRun).not.toHaveBeenCalled()
        expect(cancelForemanSessionRuns).not.toHaveBeenCalled()
    })

    it('requires a conversation id to establish ownership of a targeted run', async () => {
        const response = await DELETE(stop({ runId: 'run-1' }))

        expect(response.status).toBe(400)
        expect(engine.cancelRun).not.toHaveBeenCalled()
        expect(cancelForemanSessionRuns).not.toHaveBeenCalled()
    })

    it('fails closed when the engine cannot identify the targeted run', async () => {
        vi.mocked(engineSessionOf).mockResolvedValue({ backend: 'engine', engineSessionId: 'engine-session' })
        vi.mocked(engine.getRun).mockRejectedValue(new Error('engine unavailable'))

        const response = await DELETE(stop({ runId: 'run-1', sessionId: 'session' }))

        expect(response.status).toBe(502)
        expect(engine.cancelRun).not.toHaveBeenCalled()
        expect(cancelForemanSessionRuns).not.toHaveBeenCalled()
    })

    it('keeps the session-wide fallback for a stop with no known run id', async () => {
        const response = await DELETE(stop({ sessionId: 'session' }))

        expect(response.status).toBe(200)
        expect(cancelForemanSessionRuns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'user-1' }), 'session')
        expect(engine.getRun).not.toHaveBeenCalled()
        expect(engine.cancelRun).not.toHaveBeenCalled()
    })
})
