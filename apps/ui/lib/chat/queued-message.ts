import { nanoid } from 'nanoid'

export { parseQueued, queuedPreview, shouldFlush, shouldKeepQueued, type QueuedMessage } from '@rerun/contracts'

export type MessageAcceptance = 'accepted' | 'rejected' | 'uncertain'
export type MessageAcceptanceHandler = (outcome: MessageAcceptance) => void

export function messageAcceptance(response: Response, engine = true): MessageAcceptance {
    if (response.ok && (!engine || response.headers.get('X-Run-Id'))) return 'accepted'
    if (response.headers.has('X-Run-Id')) return 'uncertain'
    return [400, 401, 402, 403, 404, 409, 413].includes(response.status) ? 'rejected' : 'uncertain'
}

export type PendingStop = { id: string; runId: string | null; phase: 'requesting' | 'acknowledged' | 'unknown' }
export const pendingStopKey = (uid: string) => `composer-stopped-${uid}`

export function readPendingStop(uid: string): PendingStop | null {
    try {
        const raw = localStorage.getItem(pendingStopKey(uid))
        if (!raw) return null
        const value: unknown = JSON.parse(raw)
        if (value === true) return { id: 'legacy', runId: null, phase: 'unknown' }
        if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string' || !('runId' in value) || (value.runId !== null && typeof value.runId !== 'string') || !('phase' in value) || !['requesting', 'acknowledged', 'unknown'].includes(String(value.phase))) return null
        return { id: value.id, runId: value.runId, phase: value.phase === 'acknowledged' ? 'acknowledged' : 'unknown' }
    } catch { return null }
}

export function rememberPendingStop(uid: string, record: PendingStop): boolean {
    try {
        const raw = JSON.stringify(record)
        localStorage.setItem(pendingStopKey(uid), raw)
        return localStorage.getItem(pendingStopKey(uid)) === raw
    } catch { return false }
}

export function canAttemptAfterStop(stop: PendingStop | null): boolean {
    return !stop || (stop.phase !== 'requesting' && stop.runId !== null)
}

export function newPendingStop(runId: string | null): PendingStop {
    return { id: nanoid(12), runId, phase: 'requesting' }
}

export const LOCAL_REQUEST_HEADER = 'X-Rerun-Local-Request'
export function localRequestHeaders(headers: HeadersInit | undefined, requestMetadata: unknown): Headers {
    const next = new Headers(headers)
    if (typeof requestMetadata === 'object' && requestMetadata !== null && 'localRequestId' in requestMetadata && typeof requestMetadata.localRequestId === 'number') next.set(LOCAL_REQUEST_HEADER, String(requestMetadata.localRequestId))
    return next
}
