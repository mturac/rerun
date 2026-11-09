import { z } from 'zod'
import { deadlineSignal, raceAbort } from '../../lib/abort.js'
import { NonPublicHostError, assertPublicUrl } from '../../lib/public-fetch.js'

const SEARCH_URL = 'https://api.mwmbl.org/api/v2/search/'
const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024
const textSchema = z.string().transform(value => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim())

const resultSchema = z.object({
    title: textSchema,
    url: z.string().refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)).pipe(z.string().url()).refine(value => {
        const url = new URL(value)
        return /^https?:$/.test(url.protocol) && !url.username && !url.password
    }),
    content: textSchema,
}).transform(({ title, url, content }) => ({ title, url, snippet: content }))
const responseSchema = z.object({ results: z.array(resultSchema).max(1000) })

export type SearchResult = z.infer<typeof resultSchema>

let nextRequestAt = 0

export async function searchMwmbl(query: string, maxResults: number, runSignal?: AbortSignal): Promise<SearchResult[]> {
    runSignal?.throwIfAborted()
    const now = Date.now()
    if (now < nextRequestAt) throw new Error('Mwmbl search is limited to one request per second; retry later')
    nextRequestAt = now + 1000

    const signal = deadlineSignal(TIMEOUT_MS, runSignal)
    const url = new URL(SEARCH_URL)
    url.searchParams.set('q', query)
    const response = await fetch(url.href, {
        headers: { Accept: 'application/json', 'User-Agent': 'rerun-engine/1.0' },
        redirect: 'error',
        credentials: 'omit',
        signal,
    })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Mwmbl search provider answered ${response.status}`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Mwmbl search provider returned no JSON body')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw new Error('Mwmbl search response exceeded 256 KiB')
            chunks.push(value)
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown
    try {
        body = JSON.parse(text)
    } catch {
        throw new Error('Mwmbl search provider returned invalid JSON')
    }
    const parsed = responseSchema.safeParse(body)
    if (!parsed.success) throw new Error('Mwmbl search provider returned an invalid result format')
    const results: SearchResult[] = []
    for (const result of parsed.data.results.slice(0, 20)) {
        try {
            await raceAbort(assertPublicUrl(result.url), signal)
            results.push(result)
            if (results.length === maxResults) break
        } catch (e) {
            if (!(e instanceof NonPublicHostError)) throw e
        }
    }
    return results
}
