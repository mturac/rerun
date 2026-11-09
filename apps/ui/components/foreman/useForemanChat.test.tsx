// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DefaultChatTransport, UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const state: { sessionId: string; backend: string; surface: string; engineRunId: string | null; open: boolean; engaged: boolean; setActivity: ReturnType<typeof vi.fn>; setEngineRunId: ReturnType<typeof vi.fn>; pinBackend: ReturnType<typeof vi.fn> } = { sessionId: 'one', backend: 'engine', surface: 'engine', engineRunId: 'run-1', open: false, engaged: false, setActivity: vi.fn(), setEngineRunId: vi.fn(), pinBackend: vi.fn() }
    return {
    state,
    chats: new Map<string, { messages: UIMessage[]; status: string; error: Error | undefined; stop: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>; setMessages: ReturnType<typeof vi.fn>; resumeStream: ReturnType<typeof vi.fn>; clearError: ReturnType<typeof vi.fn>; regenerate: ReturnType<typeof vi.fn>; addToolResult: ReturnType<typeof vi.fn> }>(),
    pendingMetadata: new Map<string, unknown>(),
    options: new Map<string, { transport: DefaultChatTransport<UIMessage>; onFinish?: (outcome: { isAbort: boolean; isError: boolean; isDisconnect: boolean }) => void }>(),
}
})
vi.mock('@ai-sdk/react', () => ({ useChat: (options: { id: string; transport: DefaultChatTransport<UIMessage> }) => {
    mocks.options.set(options.id, options)
    if (!mocks.chats.has(options.id)) mocks.chats.set(options.id, { messages: [], status: 'ready', error: undefined, stop: vi.fn().mockResolvedValue(undefined), sendMessage: vi.fn((_message, requestOptions) => { mocks.pendingMetadata.set(options.id, requestOptions?.metadata); return Promise.resolve() }), setMessages: vi.fn(), resumeStream: vi.fn().mockResolvedValue(undefined), clearError: vi.fn(), regenerate: vi.fn(), addToolResult: vi.fn() })
    return mocks.chats.get(options.id)
} }))
vi.mock('@/stores/foreman.store', () => ({
    useForemanStore: Object.assign((select: (state: typeof mocks.state) => unknown) => select(mocks.state), { getState: () => mocks.state }),
    selectForemanBackend: (state: typeof mocks.state) => state.backend,
    selectForemanOpen: (state: typeof mocks.state) => state.open,
}))
vi.mock('@/components/foreman/foremanClientTools', () => ({ isForemanClientTool: () => false, runForemanClientTool: vi.fn() }))
vi.mock('@/components/foreman/useForemanKickoff', () => ({ refreshForemanSurface: vi.fn() }))
vi.mock('@/app/api/_actions/agent.actions', () => ({ getRunAction: vi.fn() }))
vi.mock('@/hooks/useAgentModel', () => ({ readAgentModel: () => ({}), useAgentModel: () => ({ selection: { model: null } }) }))
vi.mock('@/lib/foreman/pending-widget', () => ({ findPendingEngineHitl: () => null, findPendingWidget: () => null, resumesAfterAnswer: () => false }))
vi.mock('@/hooks/useRunReconnect', () => ({ useRunReconnect: () => false }))
vi.mock('@rerun/cloud/billing', () => ({ isWorkspaceApiEntitled: () => true }))
vi.mock('@/supabase/session/SessionProvider', () => ({ useSession: () => ({ workspace: null, refreshPhoneStep: vi.fn() }), useIsWorkspaceAdmin: () => false }))

import { useForemanChat } from './useForemanChat'
import { useQueuedMessage } from '@/hooks/useQueuedMessage'

let root: Root
let container: HTMLDivElement
let chat: ReturnType<typeof useForemanChat>
let queue: ReturnType<typeof useQueuedMessage>
function Harness() {
    chat = useForemanChat()
    queue = useQueuedMessage(`foreman-${mocks.state.sessionId}`)
    return null
}
async function render() { await act(async () => root.render(createElement(Harness))) }
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
function post(transport = mocks.options.get(`engine-${mocks.state.sessionId}`)!.transport) {
    const metadata = mocks.pendingMetadata.get(`engine-${mocks.state.sessionId}`)
    mocks.pendingMetadata.delete(`engine-${mocks.state.sessionId}`)
    return transport.sendMessages({ metadata, trigger: 'submit-message', chatId: 'engine-one', messageId: undefined, messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Follow up' }] }], abortSignal: undefined })
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    localStorage.clear()
    mocks.chats.clear()
    mocks.options.clear()
    mocks.pendingMetadata.clear()
    Object.assign(mocks.state, { sessionId: 'one', backend: 'engine', surface: 'engine', engineRunId: 'run-1' })
    mocks.state.setEngineRunId.mockReset()
    vi.stubGlobal('fetch', vi.fn())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
})

describe('engine stop', () => {
    it('sends one cancellation for a double stop, retains the run and blocks sends after an ACK', async () => {
        const response = deferred<Response>()
        vi.mocked(fetch).mockReturnValue(response.promise)
        await render()
        let first!: Promise<boolean>
        let second!: Promise<boolean>
        await act(async () => { first = chat.stop(); second = chat.stop() })
        expect(first).toBe(second)
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(chat.stopping).toBe(true)
        expect(chat.sendMessage({ text: 'Must wait' })).toBe(false)
        await act(async () => { response.resolve(new Response(null, { status: 200 })); await first })
        expect(chat.stopping).toBe(false)
        expect(chat.stopPending).toBe(true)
        expect(chat.stopNotice).toContain('Use Send now')
        expect(mocks.state.setEngineRunId).not.toHaveBeenCalled()
        expect(chat.sendMessage({ text: 'Still must wait' })).toBe(false)
        act(() => mocks.options.get('engine-one')?.onFinish?.({ isAbort: false, isError: false, isDisconnect: false }))
        expect(mocks.state.setEngineRunId).not.toHaveBeenCalled()
    })

    it('keeps an unconfirmed stop blocked after reopening the same conversation', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
        await render()
        await act(async () => { await chat.stop() })
        act(() => root.unmount())
        root = createRoot(container)
        await render()
        expect(chat.stopPending).toBe(true)
        expect(chat.sendMessage({ text: 'Do not restart automatically' })).toBe(false)
    })

    it('does not apply a late stop result to a different conversation', async () => {
        const response = deferred<Response>()
        vi.mocked(fetch).mockReturnValue(response.promise)
        await render()
        let request!: Promise<boolean>
        await act(async () => { request = chat.stop() })
        mocks.state.sessionId = 'two'
        mocks.state.engineRunId = 'run-2'
        await render()
        await act(async () => { response.resolve(new Response(null, { status: 200 })); await request })
        expect(chat.stopPending).toBe(false)
        expect(chat.stopNotice).toBeNull()
        act(() => expect(chat.sendMessage({ text: 'New conversation' })).toBe(true))
        expect(mocks.state.setEngineRunId).not.toHaveBeenCalled()
    })
})

describe('transport acceptance', () => {
    it('keeps the queued text until the engine returns a successful run header', async () => {
        const response = deferred<Response>()
        vi.mocked(fetch).mockReturnValue(response.promise)
        await render()
        await act(async () => queue.enqueue('Follow up', null))
        await act(async () => {
            const finish = queue.beginDelivery(queue.queued!.id)!
            expect(chat.sendMessage({ text: 'Follow up' }, { queued: true, onAcceptance: finish })).toBe(true)
        })
        const request = post()
        expect(queue.queued?.text).toBe('Follow up')
        await act(async () => {
            response.resolve(new Response('data: [DONE]\n\n', { headers: { 'X-Run-Id': 'run-2' } }))
            await request
        })
        expect(queue.queued).toBeNull()
        expect(mocks.state.setEngineRunId).toHaveBeenCalledWith('run-2')
    })

    it.each([409, 500])('preserves the queue and pauses retry on HTTP %s', async status => {
        vi.mocked(fetch).mockResolvedValue(new Response('not accepted', { status }))
        await render()
        await act(async () => queue.enqueue('Follow up', null))
        await act(async () => chat.sendMessage({ text: 'Follow up' }, { queued: true, onAcceptance: queue.beginDelivery(queue.queued!.id)! }))
        await act(async () => { await expect(post()).rejects.toThrow() })
        expect(queue.queued?.text).toBe('Follow up')
        expect(queue.deliveryBlocked).toBe(true)
        expect(mocks.state.setEngineRunId).not.toHaveBeenCalled()
    })

    it('keeps a network failure paused across reload', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('Connection lost'))
        await render()
        await act(async () => queue.enqueue('Uncertain delivery', null))
        await act(async () => chat.sendMessage({ text: 'Uncertain delivery' }, { queued: true, onAcceptance: queue.beginDelivery(queue.queued!.id)! }))
        await act(async () => { await expect(post()).rejects.toThrow('Connection lost') })
        expect(queue.queued?.text).toBe('Uncertain delivery')
        expect(queue.deliveryBlocked).toBe(true)
    })

    it('rejects a stale successful response', async () => {
        const response = deferred<Response>()
        vi.mocked(fetch).mockReturnValue(response.promise)
        await render()
        const transport = mocks.options.get('engine-one')!.transport
        await act(async () => queue.enqueue('Old queued text', null))
        await act(async () => chat.sendMessage({ text: 'Old queued text' }, { queued: true, onAcceptance: queue.beginDelivery(queue.queued!.id)! }))
        const request = post(transport)
        const rejected = expect(request).rejects.toThrow('Conversation changed')
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        mocks.state.sessionId = 'two'
        mocks.state.engineRunId = 'run-2'
        await render()
        await act(async () => {
            response.resolve(new Response('data: [DONE]\n\n', { headers: { 'X-Run-Id': 'run-old' } }))
            await rejected
        })
        expect(queue.queued).toBeNull()
        expect(mocks.state.setEngineRunId).not.toHaveBeenCalled()
    })
})


describe('review regressions', () => {
    it('permits an explicit admission attempt after stopping a known run', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
        await render()
        await act(async () => { await chat.stop() })
        expect(chat.sendMessage({ text: 'Automatic must wait' })).toBe(false)
        let admitted = false
        await act(async () => { admitted = chat.sendMessage({ text: 'Explicit attempt' }, { manual: true }) })
        expect(admitted).toBe(true)
    })

    it('does not reuse a previous accepted request callback for regeneration', async () => {
        const accepted = vi.fn()
        vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { 'X-Run-Id': 'run-2' } }))
        await render()
        await act(async () => chat.sendMessage({ text: 'Old accepted message' }, { onAcceptance: accepted }))
        await act(async () => { await post() })
        expect(accepted).toHaveBeenCalledTimes(1)
        vi.mocked(fetch).mockResolvedValue(new Response('busy', { status: 409 }))
        await act(async () => { await expect(post()).rejects.toThrow() })
        expect(accepted).toHaveBeenCalledTimes(1)
    })
})


describe('manual admission outcomes', () => {
    it('retains the stop and saved text on 409, then releases only on a successful explicit acceptance', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
        await render()
        await act(async () => { await chat.stop() })
        await act(async () => queue.enqueue('My next task', null))
        vi.mocked(fetch).mockResolvedValue(new Response('busy', { status: 409 }))
        await act(async () => chat.sendMessage({ text: 'My next task' }, { manual: true, onAcceptance: queue.beginDelivery(queue.queued!.id, true)! }))
        await act(async () => { await expect(post()).rejects.toThrow() })
        expect(chat.stopPending).toBe(true)
        expect(queue.queued?.text).toBe('My next task')
        expect(queue.deliveryState).toBe('rejected')
        mocks.chats.get('engine-one')!.status = 'error'
        await render()
        vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { 'X-Run-Id': 'new-run' } }))
        await act(async () => chat.sendMessage({ text: 'My next task' }, { manual: true, onAcceptance: queue.beginDelivery(queue.queued!.id, true)! }))
        await act(async () => { await post() })
        expect(chat.stopPending).toBe(false)
        expect(queue.queued).toBeNull()
        expect(mocks.state.setEngineRunId).toHaveBeenCalledWith('new-run')
        expect(localStorage.getItem('composer-stopped-foreman-one')).toBeNull()
    })

    it('does not bypass an unknown session-wide stop', async () => {
        mocks.state.engineRunId = null
        vi.mocked(fetch).mockRejectedValue(new Error('Lost cancellation response'))
        await render()
        await act(async () => { await chat.stop() })
        expect(chat.manualSendAllowed).toBe(false)
        expect(chat.sendMessage({ text: 'Unsafe new task' }, { manual: true })).toBe(false)
    })

    it('accepts a hub request once without an engine run header', async () => {
        mocks.state.backend = 'hub'
        mocks.state.surface = 'hub'
        await render()
        const accepted = vi.fn()
        vi.mocked(fetch).mockResolvedValue(new Response('data: [DONE]\n\n'))
        await act(async () => chat.sendMessage({ text: 'Hub text' }, { onAcceptance: accepted }))
        const metadata = mocks.pendingMetadata.get('one')
        await act(async () => { await mocks.options.get('one')!.transport.sendMessages({ metadata, trigger: 'submit-message', chatId: 'one', messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Hub text' }] }], messageId: undefined, abortSignal: undefined }) })
        expect(accepted).toHaveBeenCalledExactlyOnceWith('accepted')
    })
})


it('keeps the outcome unknown when the run identity was never observed', async () => {
    mocks.state.engineRunId = null
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
    await render()
    await act(async () => { await chat.stop() })
    expect(chat.manualSendAllowed).toBe(false)
    expect(chat.sendMessage({ text: 'Do not race an unobserved POST' }, { manual: true })).toBe(false)
})

describe('stop targeting', () => {
    it('only stops the local stream when no run identity was observed', async () => {
        mocks.state.engineRunId = null
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
        await render()
        await act(async () => { await chat.stop() })
        expect(mocks.chats.get('engine-one')!.stop).toHaveBeenCalledTimes(1)
        expect(fetch).not.toHaveBeenCalled()
        expect(chat.stopNotice).toContain('Stop outcome is unknown')
        expect(chat.manualSendAllowed).toBe(false)
    })

    it('does not cancel an old run or scan the session while a new POST has no run header yet', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
        await render()
        await act(async () => chat.sendMessage({ text: 'A request without an acceptance header yet' }))
        await act(async () => { await chat.stop() })
        expect(mocks.chats.get('engine-one')!.stop).toHaveBeenCalledTimes(1)
        expect(fetch).not.toHaveBeenCalled()
        expect(chat.stopNotice).toContain('Stop outcome is unknown')
        expect(chat.manualSendAllowed).toBe(false)
    })

    it('continues to cancel exactly the captured known run', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
        await render()
        await act(async () => { await chat.stop() })
        expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/chat/foreman/engine?sessionId=one&runId=run-1', { method: 'DELETE' })
        expect(chat.manualSendAllowed).toBe(true)
    })
})
