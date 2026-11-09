'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { canAttemptAfterStop, newPendingStop, parseQueued, pendingStopKey, readPendingStop, rememberPendingStop, type MessageAcceptance, type PendingStop, type QueuedMessage } from '@/lib/chat/queued-message'

type RecoveredMessage = QueuedMessage & { uncertain: boolean }
type Delivery = 'waiting' | 'sending' | 'rejected' | 'uncertain'
type QueueState = { autoSendEligible: boolean; uid: string; queued: QueuedMessage | null; restoredId: string | null; attemptedId: string | null; delivery: Delivery; recovered: RecoveredMessage[]; storageError: string | null }
const keyOf = (uid: string) => `composer-queued-${uid}`
const attemptKeyOf = (uid: string) => `composer-queued-attempt-${uid}`
const recoveryKeyOf = (uid: string) => `composer-unsent-${uid}`
const recoveryItemKey = (uid: string, id: string) => `${recoveryKeyOf(uid)}:${id}`
const STORAGE_ERROR = 'Messages are not saved in this browser. Keep this page open and copy your text before reloading.'

function read(uid: string): QueueState {
    const state: QueueState = { autoSendEligible: false, uid, queued: null, restoredId: null, attemptedId: null, delivery: 'waiting', recovered: [], storageError: null }
    try {
        state.queued = parseQueued(localStorage.getItem(keyOf(uid)))
        state.restoredId = state.queued?.id ?? null
        const marker = localStorage.getItem(attemptKeyOf(uid))
        if (marker) {
            state.attemptedId = marker === state.queued?.id ? marker : null
            try {
                const value: unknown = JSON.parse(marker)
                if (state.queued !== null && typeof value === 'object' && value !== null && 'id' in value && value.id === state.queued.id) {
                    state.attemptedId = state.queued.id
                    state.delivery = 'phase' in value && value.phase === 'rejected' ? 'rejected' : 'uncertain'
                }
            } catch {}
            if (state.attemptedId && state.delivery === 'waiting') state.delivery = 'uncertain'
        }
        const legacy: unknown = JSON.parse(localStorage.getItem(recoveryKeyOf(uid)) ?? '[]')
        const values: unknown[] = Array.isArray(legacy) ? [...legacy] : []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(`${recoveryKeyOf(uid)}:`)) values.push(JSON.parse(localStorage.getItem(key) ?? 'null'))
        }
        const found = new Map<string, RecoveredMessage>()
        for (const value of values) {
            const item = parseQueued(JSON.stringify(value))
            if (item) found.set(item.id, { ...item, uncertain: typeof value === 'object' && value !== null && 'uncertain' in value && value.uncertain === true })
        }
        state.recovered = [...found.values()].filter(item => item.id !== state.queued?.id)
    } catch { state.storageError = STORAGE_ERROR }
    return state
}

function persist(key: string, value: unknown): boolean {
    try {
        const raw = JSON.stringify(value)
        localStorage.setItem(key, raw)
        return localStorage.getItem(key) === raw
    } catch { return false }
}

export function useQueuedMessage(uid: string, legacyUid?: string) {
    const [state, setState] = useState<QueueState>(() => ({ autoSendEligible: false, uid, queued: null, restoredId: null, attemptedId: null, delivery: 'waiting', recovered: [], storageError: null }))
    const live = useRef(state)
    const currentUid = useRef(uid)
    currentUid.current = uid
    const update = useCallback((next: QueueState) => {
        if (currentUid.current !== next.uid) return
        live.current = next
        setState(next)
    }, [])
    const warn = useCallback(() => { if (live.current.uid === uid) update({ ...live.current, storageError: STORAGE_ERROR }) }, [uid, update])

    useEffect(() => {
        const next = read(uid)
        const legacy = legacyUid ? read(legacyUid).queued : null
        if (legacyUid && legacy && !next.recovered.some(item => item.id === legacy.id)) {
            const item = { ...legacy, uncertain: true }
            next.recovered.push(item)
            if (persist(recoveryItemKey(uid, item.id), item)) {
                try { localStorage.removeItem(keyOf(legacyUid)); localStorage.removeItem(attemptKeyOf(legacyUid)) } catch { next.storageError = STORAGE_ERROR }
            } else next.storageError = STORAGE_ERROR
        }
        update(next)
    }, [uid, legacyUid, update])
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key !== null && event.key !== keyOf(uid) && event.key !== attemptKeyOf(uid) && !event.key.startsWith(recoveryKeyOf(uid))) return
            const next = read(uid)
            // Another tab's queue is for review here, never another automatic sender.
            if (live.current.queued?.id === next.queued?.id) { next.restoredId = live.current.restoredId; next.autoSendEligible = live.current.autoSendEligible }
            if (live.current.delivery === 'sending' && live.current.queued?.id === next.queued?.id) next.delivery = 'sending'
            update(next)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [uid, update])

    const recover = useCallback((text: string, restore: (text: string) => boolean, uncertain = false) => {
        if (!uncertain && restore(text)) return true
        const current = live.current.uid === uid ? live.current : read(uid)
        const item: RecoveredMessage = { id: nanoid(8), text, createdAt: Date.now(), behindRunId: null, uncertain }
        const saved = persist(recoveryItemKey(uid, item.id), item)
        update({ ...current, recovered: [...current.recovered, item], storageError: saved ? current.storageError : STORAGE_ERROR })
        return saved
    }, [uid, update])

    const restoreRecovered = useCallback((id: string, restore: (text: string) => boolean) => {
        const current = live.current
        const item = current.uid === uid ? current.recovered.find(item => item.id === id) : null
        if (!item || !restore(item.text)) return false
        try {
            localStorage.removeItem(recoveryItemKey(uid, id))
            const remaining = current.recovered.filter(item => item.id !== id)
            // Older versions used one array. Preserve its other entries while migrating.
            if (localStorage.getItem(recoveryKeyOf(uid)) && !persist(recoveryKeyOf(uid), remaining)) { warn(); return false }
            update({ ...current, recovered: remaining })
            return true
        } catch { warn(); return false }
    }, [uid, update, warn])

    const enqueue = useCallback((text: string, behindRunId: string | null) => {
        const current = live.current.uid === uid ? live.current : read(uid)
        if (current.queued && current.delivery === 'sending') return recover(text, () => false)
        if (current.queued) {
            const previous = { ...current.queued, uncertain: current.delivery === 'uncertain' }
            if (!persist(recoveryItemKey(uid, previous.id), previous)) { warn(); return false }
            update({ ...current, recovered: [...current.recovered.filter(item => item.id !== previous.id), previous] })
        }
        const item: QueuedMessage = { id: nanoid(8), text, createdAt: Date.now(), behindRunId }
        // Each text has its own durable record before the shared visible slot can change.
        if (!persist(recoveryItemKey(uid, item.id), { ...item, uncertain: false })) { warn(); return false }
        if (!persist(keyOf(uid), item)) {
            update({ ...live.current, recovered: [...live.current.recovered, { ...item, uncertain: false }], storageError: STORAGE_ERROR })
            return false
        }
        try { localStorage.removeItem(attemptKeyOf(uid)) } catch { warn(); return false }
        update({ ...live.current, uid, queued: item, attemptedId: null, delivery: 'waiting', restoredId: null, autoSendEligible: true })
        return true
    }, [uid, update, recover, warn])

    const visibleId = state.uid === uid ? state.queued?.id : undefined
    const clear = useCallback(() => {
        const current = live.current
        if (!visibleId || current.uid !== uid || current.queued?.id !== visibleId || (current.delivery === 'sending' || current.delivery === 'uncertain')) return false
        try {
            if (parseQueued(localStorage.getItem(keyOf(uid)))?.id !== visibleId) return false
            localStorage.removeItem(keyOf(uid))
            localStorage.removeItem(recoveryItemKey(uid, visibleId))
            localStorage.removeItem(attemptKeyOf(uid))
            update({ ...current, queued: null, attemptedId: null, delivery: 'waiting' })
            return true
        } catch { warn(); return false }
    }, [uid, visibleId, update, warn])

    const beginDelivery = useCallback((id: string, manual = false): ((outcome: MessageAcceptance | 'not-sent') => void) | null => {
        const current = live.current
        if (current.uid !== uid || current.queued?.id !== id || current.delivery === 'sending' || (current.attemptedId === id && !(manual && current.delivery === 'rejected'))) return null
        try {
            if (parseQueued(localStorage.getItem(keyOf(uid)))?.id !== id) { warn(); return null }
            const existing = read(uid)
            if (existing.attemptedId === id && !(manual && existing.delivery === 'rejected')) {
                update({ ...current, attemptedId: id, delivery: existing.delivery })
                return null
            }
        } catch { warn(); return null }
        if (!persist(attemptKeyOf(uid), { id, phase: 'sending' })) { warn(); return null }
        update({ ...current, attemptedId: id, delivery: 'sending' })
        let finished = false
        return outcome => {
            if (finished) return
            finished = true
            const latest = live.current
            if (outcome === 'accepted' || outcome === 'not-sent') {
                try {
                    if (outcome === 'accepted') localStorage.removeItem(recoveryItemKey(uid, id))
                    if (parseQueued(localStorage.getItem(keyOf(uid)))?.id === id) {
                        if (outcome === 'accepted') localStorage.removeItem(keyOf(uid))
                        localStorage.removeItem(attemptKeyOf(uid))
                    }
                } catch { warn() }
                if (latest.uid === uid) update({ ...latest, recovered: outcome === 'accepted' ? latest.recovered.filter(item => item.id !== id) : latest.recovered, ...(latest.queued?.id === id ? { queued: outcome === 'accepted' ? null : latest.queued, attemptedId: null, delivery: 'waiting' as const } : {}) })
                return
            }
            const saved = persist(attemptKeyOf(uid), { id, phase: outcome })
            if (latest.uid === uid && latest.queued?.id === id) update({ ...latest, delivery: outcome, storageError: saved ? latest.storageError : STORAGE_ERROR })
        }
    }, [uid, update, warn])

    const reviewQueued = useCallback(() => {
        const current = live.current
        if (current.uid !== uid || !current.queued || current.delivery === 'sending') return false
        const item = { ...current.queued, uncertain: current.delivery === 'uncertain' }
        if (!persist(recoveryItemKey(uid, item.id), item)) { warn(); return false }
        try {
            if (parseQueued(localStorage.getItem(keyOf(uid)))?.id !== item.id) return false
            localStorage.removeItem(keyOf(uid))
            localStorage.removeItem(attemptKeyOf(uid))
        } catch { warn(); return false }
        update({ ...current, queued: null, attemptedId: null, delivery: 'waiting', recovered: [...current.recovered, item] })
        return true
    }, [uid, update, warn])

    const visible = state.uid === uid ? state : { autoSendEligible: false, queued: null, restoredId: null, attemptedId: null, delivery: 'waiting' as const, recovered: [], storageError: null }
    return { autoSendEligible: visible.autoSendEligible, queued: visible.queued, restoredId: visible.restoredId, deliveryBlocked: visible.attemptedId !== null, deliveryState: visible.delivery, storageError: visible.storageError, recovered: visible.recovered.filter(item => item.id !== visible.queued?.id), enqueue, clear, beginDelivery, recover, restoreRecovered, reviewQueued }
}

export function useStopRequestState(uid: string) {
    const [state, setState] = useState<{ uid: string; stop: PendingStop | null; storageError: boolean }>({ uid, stop: null, storageError: false })
    const live = useRef(state)
    const currentUid = useRef(uid)
    currentUid.current = uid
    const update = useCallback((stop: PendingStop | null, storageError = false) => {
        if (currentUid.current !== uid) return
        live.current = { uid, stop, storageError }
        setState(live.current)
    }, [uid])
    useEffect(() => {
        update(readPendingStop(uid))
        const listener = (event: StorageEvent) => { if (event.key === null || event.key === pendingStopKey(uid)) update(readPendingStop(uid)) }
        window.addEventListener('storage', listener)
        return () => window.removeEventListener('storage', listener)
    }, [uid, update])
    const current = useCallback(() => live.current.uid === uid && live.current.stop?.phase === 'requesting' ? live.current.stop : readPendingStop(uid) ?? (live.current.uid === uid ? live.current.stop : null), [uid])
    const begin = useCallback((runId: string | null) => {
        const stop = newPendingStop(runId)
        const saved = rememberPendingStop(uid, stop)
        update(stop, !saved)
        return stop
    }, [uid, update])
    const finish = useCallback((request: PendingStop, acknowledged: boolean) => {
        if (current()?.id !== request.id) return
        const stop: PendingStop = { ...request, phase: acknowledged ? 'acknowledged' : 'unknown' }
        const saved = rememberPendingStop(uid, stop)
        update(stop, !saved)
    }, [uid, current, update])
    const release = useCallback((id: string | undefined) => {
        if (!id || current()?.id !== id) return
        try { localStorage.removeItem(pendingStopKey(uid)); update(null) } catch { update(current(), true) }
    }, [uid, current, update])
    const stop = state.uid === uid ? state.stop : null
    return { stop, current, begin, finish, release, manualAllowed: canAttemptAfterStop(stop), storageError: state.uid === uid && state.storageError }
}
