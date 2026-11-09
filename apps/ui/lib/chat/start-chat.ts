import { chat } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'

type ChatParams = Parameters<typeof chat>[2]

// A queued message leaves the moment the conversation reads as free on the client, but the engine
// only drops its session claim once the run has written its transcript and torn its provider down,
// which takes seconds on a CLI provider. So a 409 here is the normal path, not an incident.
export const QUEUED_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500, 2_500, 4_000, 4_000, 4_000, 4_000, 4_000]

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal?.reason)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, delay)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export async function startChat(conn: EngineConnection, engineAgentId: string, params: ChatParams, delays: readonly number[] | null, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted()
    let res = await chat(conn, engineAgentId, params)
    for (const delay of delays ?? []) {
        if (res.status !== 409) break
        await res.body?.cancel().catch(() => {})
        await waitForRetry(delay, signal)
        signal?.throwIfAborted()
        res = await chat(conn, engineAgentId, params)
    }
    return res
}
