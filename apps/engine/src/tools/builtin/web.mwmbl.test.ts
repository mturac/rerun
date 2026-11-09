import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { webTools } from './web.js'
import { searchMwmbl } from './mwmbl-search.js'
import type { RunContext } from '../../runtime/context.js'

const settings = vi.hoisted(() => ({ fallback: 'mwmbl' as string | undefined }))
vi.mock('../../config/env.js', () => ({ env: () => ({ RERUN_DATA_DIR: '/tmp/rerun-mwmbl-test', RERUN_LOG_LEVEL: 'fatal', RERUN_API_KEY: 'engine-secret', RERUN_HUB_BASE_URL: 'https://hub.example.test', RERUN_WEB_SEARCH_FALLBACK: settings.fallback }) }))
vi.mock('./mwmbl-search.js', () => ({ searchMwmbl: vi.fn() }))

const fetchMock = vi.fn<typeof fetch>()
const results = [{ title: 'Handbook', url: 'https://typescriptlang.org/docs/', snippet: 'Learn TypeScript' }]
const ctx = { agent: { id: 'surfer', config: { tools: { paidData: false } } } } as RunContext

async function search(signal?: AbortSignal, toolSignal?: AbortSignal): Promise<unknown> {
    const execute = webTools({ ...ctx, abortSignal: signal }).web_search.execute
    if (!execute) throw new Error('web_search has no execute')
    return execute({ query: 'TypeScript handbook', maxResults: 3 }, { toolCallId: 'test-search', messages: [], abortSignal: toolSignal })
}

beforeEach(() => {
    settings.fallback = 'mwmbl'
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.mocked(searchMwmbl).mockReset().mockResolvedValue(results)
    fetchMock.mockImplementation(async () => Response.json({ error: 'Web search is not configured' }, { status: 503 }))
})

afterEach(() => vi.unstubAllGlobals())

describe('the opt-in Mwmbl fallback', () => {
    it('uses the fallback only after an authenticated hub reports no search provider', async () => {
        const controller = new AbortController()
        const output = await search(controller.signal)
        expect(output).toContain('Mwmbl search uses a limited independent index')
        expect(output).toContain('1. Handbook\n   https://typescriptlang.org/docs/\n   Learn TypeScript')
        expect(fetchMock).toHaveBeenCalledWith('https://hub.example.test/api/search', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer engine-secret', 'x-rerun-agent': 'surfer' }) }))
        expect(searchMwmbl).toHaveBeenCalledWith('TypeScript handbook', 3, controller.signal)
    })

    it.each([307, 308])('refuses hub HTTP %s redirects without a fallback or a second request', async status => {
        fetchMock.mockResolvedValue(Response.json({ error: 'Web search is not configured' }, { status, headers: { location: 'https://foreign.example.test/collect' } }))
        expect(await search()).toBe('Search failed: Web search is not configured')
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error')
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it.each(['context', 'tool'])('honors the %s cancellation when both signals exist', async owner => {
        const context = new AbortController()
        const tool = new AbortController()
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }))
        const output = search(context.signal, tool.signal)
        const stopping = owner === 'context' ? context : tool
        stopping.abort(new Error(`${owner} stopped`))
        expect(await output).toBe(`Search failed: ${owner} stopped`)
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it.each(['context', 'tool'])('does not start fallback after the %s signal stops at the hub boundary', async owner => {
        const context = new AbortController()
        const tool = new AbortController()
        fetchMock.mockImplementation(async () => {
            const stopping = owner === 'context' ? context : tool
            stopping.abort(new Error(`${owner} stopped`))
            return Response.json({ error: 'Web search is not configured' }, { status: 503 })
        })
        expect(await search(context.signal, tool.signal)).toBe(`Search failed: ${owner} stopped`)
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it('does not contact the hub or fallback for an already cancelled tool call', async () => {
        const context = new AbortController()
        const tool = new AbortController()
        tool.abort(new Error('already stopped'))
        expect(await search(context.signal, tool.signal)).toBe('Search failed: already stopped')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it('preserves the default error with no opt-in', async () => {
        settings.fallback = undefined
        expect(await search()).toBe('Search failed: Web search is not configured')
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it.each([401, 403, 429, 500, 502])('does not fallback on hub HTTP %s even with the same message', async status => {
        fetchMock.mockResolvedValue(Response.json({ error: 'Web search is not configured' }, { status }))
        expect(await search()).toBe('Search failed: Web search is not configured')
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it('does not fallback on an unrelated 503 or a network failure', async () => {
        fetchMock.mockResolvedValue(Response.json({ error: 'Maintenance' }, { status: 503 }))
        expect(await search()).toBe('Search failed: Maintenance')
        fetchMock.mockRejectedValue(new Error('ECONNRESET'))
        expect(await search()).toBe('Search failed: ECONNRESET')
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it('preserves successful Brave results and genuine empty results', async () => {
        fetchMock.mockResolvedValue(Response.json({ results }))
        expect(await search()).toBe('1. Handbook\n   https://typescriptlang.org/docs/\n   Learn TypeScript')
        fetchMock.mockResolvedValue(Response.json({ results: [] }))
        expect(await search()).toBe('No results.')
        expect(searchMwmbl).not.toHaveBeenCalled()
    })

    it('distinguishes an empty fallback from a failed fallback', async () => {
        vi.mocked(searchMwmbl).mockResolvedValue([])
        expect(await search()).toMatch(/Mwmbl search uses a limited independent index[\s\S]*No results\.$/)
        vi.mocked(searchMwmbl).mockRejectedValue(new Error('Mwmbl search provider answered 429'))
        expect(await search()).toBe('Search failed: Mwmbl search provider answered 429')
    })
})
