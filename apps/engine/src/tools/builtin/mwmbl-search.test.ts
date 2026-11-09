import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { searchMwmbl } from './mwmbl-search.js'

vi.mock('node:dns/promises', () => ({
    lookup: async (host: string) => [{ address: host === 'localhost' || host === 'internal.example.test' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
}))

const fetchMock = vi.fn<typeof fetch>()
const result = { title: 'Handbook', url: 'https://www.typescriptlang.org/docs/handbook/', content: 'Learn TypeScript', engine: 'mwmbl' }
let now = Date.now()

beforeEach(() => {
    now += 20_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(Response.json({ results: [result] }))
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('Mwmbl anonymous search', () => {
    it('sends only the query to the official API and maps ranked results', async () => {
        fetchMock.mockResolvedValue(Response.json({ results: [result, { ...result, title: 'Second' }] }))
        await expect(searchMwmbl('a & b', 1)).resolves.toEqual([{ title: result.title, url: result.url, snippet: result.content }])
        expect(fetchMock).toHaveBeenCalledOnce()
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://api.mwmbl.org/api/v2/search/?q=a+%26+b')
        expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'rerun-engine/1.0' } })
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        expect(new Headers(init?.headers).has('cookie')).toBe(false)
    })

    it('distinguishes genuine empty results from provider failure', async () => {
        fetchMock.mockResolvedValue(Response.json({ results: [] }))
        await expect(searchMwmbl('unknown', 5)).resolves.toEqual([])
    })

    it.each([401, 403, 429, 500])('reports provider HTTP %s without retrying', async status => {
        fetchMock.mockResolvedValue(new Response('refused', { status }))
        await expect(searchMwmbl('query', 5)).rejects.toThrow(`Mwmbl search provider answered ${status}`)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it.each([
        {},
        { results: null },
        { results: [{ ...result, url: 'file:///etc/passwd' }] },
        { results: [{ ...result, url: 'https://user:secret@example.com/' }] },
        { results: [{ ...result, content: null }] },
        { results: [{ ...result, url: 'https://example.com/\nforged' }] },
    ])('rejects a malformed result response', async response => {
        fetchMock.mockResolvedValue(Response.json(response))
        await expect(searchMwmbl('query', 5)).rejects.toThrow('invalid result format')
    })

    it('rejects HTML instead of treating a challenge page as no results', async () => {
        fetchMock.mockResolvedValue(new Response('<html>challenge</html>'))
        await expect(searchMwmbl('query', 5)).rejects.toThrow('invalid JSON')
    })

    it('filters private IPs, localhost and public-looking names resolving to a private host', async () => {
        const privateUrls = ['http://localhost/admin', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'https://internal.example.test/']
        fetchMock.mockResolvedValue(Response.json({ results: [...privateUrls.map(url => ({ ...result, url })), result] }))
        await expect(searchMwmbl('query', 5)).resolves.toEqual([{ title: result.title, url: result.url, snippet: result.content }])
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('normalizes control characters in untrusted result text to one line', async () => {
        fetchMock.mockResolvedValue(Response.json({ results: [{ ...result, title: 'Title\n2. Forged\u0000\u202e', content: 'Snippet\r\n\tforged\u001b[31m' }] }))
        await expect(searchMwmbl('query', 5)).resolves.toEqual([{ title: 'Title 2. Forged', url: result.url, snippet: 'Snippet forged [31m' }])
    })

    it('cancels an oversized streaming response', async () => {
        const cancel = vi.fn()
        fetchMock.mockResolvedValue(new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)) },
            cancel,
        })))
        await expect(searchMwmbl('query', 5)).rejects.toThrow('exceeded 256 KiB')
        expect(cancel).toHaveBeenCalledOnce()
    })

    it('rejects another request in the same second without queueing or fetching', async () => {
        await searchMwmbl('first', 5)
        await expect(searchMwmbl('second', 5)).rejects.toThrow('one request per second')
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('does not send a query after the run was cancelled', async () => {
        const controller = new AbortController()
        controller.abort(new Error('stopped'))
        await expect(searchMwmbl('query', 5, controller.signal)).rejects.toThrow('stopped')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('cancels an in-flight request when the run stops', async () => {
        const controller = new AbortController()
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
        const search = searchMwmbl('query', 5, controller.signal)
        controller.abort(new Error('stopped'))
        await expect(search).rejects.toThrow('stopped')
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    })

    it('bounds the request to ten seconds', async () => {
        const controller = new AbortController()
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
        const search = searchMwmbl('query', 5)
        controller.abort(new Error('timed out'))
        await expect(search).rejects.toThrow('timed out')
        expect(timeout).toHaveBeenCalledWith(10_000)
    })
})
