import { chat } from '@/lib/engine/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startChat } from './start-chat'

vi.mock('@/lib/engine/client', () => ({ chat: vi.fn() }))

const conn = { baseUrl: 'https://engine.test', apiKey: null }
const params = { sessionId: 'session', message: 'Send the invoice' }
const busy = () => Response.json({ code: 'run_in_flight', runId: 'earlier-run' }, { status: 409 })

describe('chat admission retries', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('does not start admission for a request already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        vi.mocked(chat).mockImplementation(async () => busy())

        await expect(startChat(conn, 'agent', params, null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })

        expect(chat).not.toHaveBeenCalled()
    })

    it('ends a retry wait when aborted and never sends after the conversation becomes free', async () => {
        const controller = new AbortController()
        vi.mocked(chat).mockImplementationOnce(async () => busy()).mockResolvedValue(new Response('accepted'))
        const pending = startChat(conn, 'agent', params, [1_000], controller.signal)
        const stopped = pending.then(response => ({ response }), (error: unknown) => ({ error }))
        await vi.advanceTimersByTimeAsync(0)
        expect(chat).toHaveBeenCalledTimes(1)

        controller.abort()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(await stopped).toMatchObject({ error: { name: 'AbortError' } })

        expect(chat).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not retry when abort happens while disposing the rejected response', async () => {
        const controller = new AbortController()
        vi.mocked(chat).mockResolvedValue(new Response(new ReadableStream({ cancel: () => { controller.abort() } }), { status: 409 }))
        const pending = startChat(conn, 'agent', params, [250], controller.signal)
        const stopped = pending.then(response => ({ response }), (error: unknown) => ({ error }))

        await vi.runAllTimersAsync()
        expect(await stopped).toMatchObject({ error: { name: 'AbortError' } })

        expect(chat).toHaveBeenCalledTimes(1)
    })

    it('cleans up the abort listener after a successful retry wait', async () => {
        const controller = new AbortController()
        const addListener = vi.spyOn(controller.signal, 'addEventListener')
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
        vi.mocked(chat).mockImplementationOnce(async () => busy()).mockResolvedValue(new Response('accepted'))
        const pending = startChat(conn, 'agent', params, [250], controller.signal)

        await vi.runAllTimersAsync()
        const response = await pending

        expect(response.status).toBe(200)
        expect(await response.text()).toBe('accepted')
        expect(chat).toHaveBeenCalledTimes(2)
        expect(addListener).toHaveBeenCalledOnce()
        expect(removeListener).toHaveBeenCalledWith('abort', addListener.mock.calls[0][1])
        expect(vi.getTimerCount()).toBe(0)
    })

    it('preserves an acknowledgement from an admission already in flight when abort occurs', async () => {
        const controller = new AbortController()
        const accepted = new Response('accepted', { headers: { 'x-run-id': 'accepted-run' } })
        vi.mocked(chat).mockImplementation(async () => {
            controller.abort()
            return accepted
        })

        const response = await startChat(conn, 'agent', params, [250], controller.signal)

        expect(response).toBe(accepted)
        expect(response.headers.get('x-run-id')).toBe('accepted-run')
        expect(chat).toHaveBeenCalledOnce()
    })
})
