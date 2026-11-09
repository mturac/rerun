import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-notify-'))
process.env.RERUN_HUB_BASE_URL = 'https://hub.test/'
process.env.RERUN_API_KEY = 'engine-token'

const { afterEach, describe, expect, it, vi } = await import('vitest')
const { sendNotification } = await import('./notify.js')

const originalFetch = globalThis.fetch

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    const fn = vi.fn(impl)
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
}

afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
})

describe('sendNotification', () => {
    it('posts to the engine webhook without doubling the trailing slash, with the bearer token', async () => {
        const fetchMock = mockFetch(async () => new Response(null, { status: 204 }))

        const result = await sendNotification({ kind: 'info', agentId: 'a1', message: 'hello' })

        expect(result).toEqual({ delivered: true })
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://hub.test/api/webhooks/engine')
        expect(init.method).toBe('POST')
        expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer engine-token' })
        expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('fills every optional field of the payload with a default', async () => {
        const fetchMock = mockFetch(async () => new Response(null, { status: 200 }))

        await sendNotification({ kind: 'question', agentId: null, message: 'm' })

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
        expect(body).toEqual({
            event: 'agent.notification',
            kind: 'question',
            agentId: null,
            sessionId: null,
            runId: null,
            message: 'm',
            metadata: null,
            title: null,
            source: null,
            originAgentId: null,
            timestamp: expect.any(String),
        })
        expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false)
    })

    it('passes the given fields through unchanged', async () => {
        const fetchMock = mockFetch(async () => new Response(null, { status: 200 }))

        await sendNotification({ event: 'agent.session.created', kind: 'done', agentId: 'a', sessionId: 's', runId: 'r', message: 'm', metadata: { x: 1 }, title: 't', source: 'schedule', originAgentId: 'o' })

        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ event: 'agent.session.created', kind: 'done', agentId: 'a', sessionId: 's', runId: 'r', metadata: { x: 1 }, title: 't', source: 'schedule', originAgentId: 'o' })
    })

    it('clamps title and message to the hub schema bounds instead of failing validation', async () => {
        const fetchMock = mockFetch(async () => new Response(null, { status: 200 }))

        await sendNotification({ kind: 'info', agentId: 'a', message: 'x'.repeat(20_000), title: 't'.repeat(500) })

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
        expect(body.title).toHaveLength(200)
        expect(body.message).toHaveLength(16_000)

        await sendNotification({ kind: 'info', agentId: 'a', message: '' })
        expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).message).toBe('Notification')
    })

    it('reports the status of a refused delivery', async () => {
        mockFetch(async () => new Response('nope', { status: 503 }))

        expect(await sendNotification({ kind: 'info', agentId: 'a', message: 'm' })).toEqual({ delivered: false, reason: 'status 503' })
    })

    it('reports a network error instead of throwing', async () => {
        mockFetch(async () => {
            throw new Error('ECONNREFUSED')
        })

        expect(await sendNotification({ kind: 'info', agentId: 'a', message: 'm' })).toEqual({ delivered: false, reason: 'ECONNREFUSED' })
    })

    it('stringifies a thrown value that is not an Error', async () => {
        mockFetch(async () => {
            throw 'socket hang up'
        })

        expect(await sendNotification({ kind: 'info', agentId: 'a', message: 'm' })).toEqual({ delivered: false, reason: 'socket hang up' })
    })

    it('gives up on a hub that does not answer within 5 seconds', async () => {
        vi.useFakeTimers()
        mockFetch(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal!.addEventListener('abort', () => reject(new Error('aborted by timeout')))
                }),
        )

        const pending = sendNotification({ kind: 'info', agentId: 'a', message: 'm' })
        await vi.advanceTimersByTimeAsync(4999)
        let settled = false
        void pending.then(() => (settled = true))
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)

        await vi.advanceTimersByTimeAsync(1)
        expect(await pending).toEqual({ delivered: false, reason: 'aborted by timeout' })
    })
})
