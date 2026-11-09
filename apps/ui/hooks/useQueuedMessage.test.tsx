// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useQueuedMessage, useStopRequestState } from './useQueuedMessage'

let root: Root
let container: HTMLDivElement
let queue: ReturnType<typeof useQueuedMessage>
function Harness({ uid }: { uid: string }) {
    queue = useQueuedMessage(uid)
    return createElement('textarea', { defaultValue: 'My newer draft', 'aria-label': 'Draft' })
}
async function mount(uid = 'one') {
    await act(async () => root.render(createElement(Harness, { uid })))
}
const stored = (uid = 'one') => JSON.parse(localStorage.getItem(`composer-queued-${uid}`) ?? 'null')

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
})
afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('message recovery', () => {
    it('keeps a refused message and an existing queue without overwriting the newer draft', async () => {
        await mount()
        const draft = container.querySelector('textarea')!
        await act(async () => {
            queue.enqueue('My queued follow-up', 'run-1')
            queue.recover('The refused message', text => {
                if (draft.value) return false
                draft.value = text
                return true
            })
        })
        expect(draft.value).toBe('My newer draft')
        expect(queue.queued?.text).toBe('My queued follow-up')
        expect(queue.recovered.map(item => item.text)).toEqual(['The refused message'])
        act(() => root.unmount())
        root = createRoot(container)
        await mount()
        expect(queue.recovered.map(item => item.text)).toEqual(['The refused message'])
    })

    it('keeps every failed message until its explicit restoration succeeds', async () => {
        await mount()
        await act(async () => {
            queue.recover('First message', () => false)
            queue.recover('Second message', () => false)
        })
        const first = queue.recovered[0]
        await act(async () => queue.restoreRecovered(first.id, () => false))
        expect(queue.recovered).toHaveLength(2)
        await act(async () => queue.restoreRecovered(first.id, () => true))
        expect(queue.recovered.map(item => item.text)).toEqual(['Second message'])
    })
})

describe('legacy recovery', () => {
    it('moves the old foreman queue into visible recovery without automatically sending it', async () => {
        localStorage.setItem('composer-queued-foreman', JSON.stringify({ id: 'legacy', text: 'Old foreman message', createdAt: 1, behindRunId: 'old-run' }))
        function LegacyHarness() {
            queue = useQueuedMessage('foreman-one', 'foreman')
            return null
        }
        await act(async () => root.render(createElement(LegacyHarness)))
        expect(queue.queued).toBeNull()
        expect(queue.recovered.map(item => item.text)).toEqual(['Old foreman message'])
        expect(localStorage.getItem('composer-queued-foreman')).toBeNull()
        expect(JSON.parse(localStorage.getItem('composer-unsent-foreman-one:legacy')!).text).toBe('Old foreman message')
    })
})

describe('queued delivery acceptance', () => {
    it('retains a message across SDK handoff and only removes it after server acceptance', async () => {
        await mount()
        await act(async () => queue.enqueue('Keep until accepted', null))
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        expect(stored().text).toBe('Keep until accepted')
        expect(queue.deliveryBlocked).toBe(true)
        await act(async () => finish?.('accepted'))
        expect(queue.queued).toBeNull()
        expect(stored()).toBeNull()
    })

    it.each(['rejected', 'uncertain'] as const)('preserves %s outcomes across reload without automatic retry', async outcome => {
        await mount()
        await act(async () => queue.enqueue('Must survive', null))
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        await act(async () => finish?.(outcome))
        expect(stored().text).toBe('Must survive')
        act(() => root.unmount())
        root = createRoot(container)
        await mount()
        expect(queue.queued?.text).toBe('Must survive')
        expect(queue.deliveryBlocked).toBe(true)
        expect(queue.beginDelivery(queue.queued!.id)).toBeNull()
    })

    it('honors an attempt marker written by another tab before its storage event arrives', async () => {
        await mount()
        await act(async () => queue.enqueue('One pending message', null))
        localStorage.setItem('composer-queued-attempt-one', queue.queued!.id)
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        expect(finish).toBeNull()
        expect(queue.deliveryBlocked).toBe(true)
    })

    it('does not hand a message off when its attempt marker cannot be persisted', async () => {
        await mount()
        await act(async () => queue.enqueue('Must not send without a marker', null))
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        expect(finish).toBeNull()
        expect(queue.queued?.text).toBe('Must not send without a marker')
        write.mockRestore()
    })

    it('does not remove a replacement queue or mutate a different conversation on a late response', async () => {
        await mount()
        await act(async () => queue.enqueue('Old message', null))
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        await act(async () => queue.enqueue('Replacement', null))
        await mount('two')
        await act(async () => queue.enqueue('Other conversation', null))
        await act(async () => finish?.('accepted'))
        expect(queue.queued?.text).toBe('Other conversation')
        expect(stored('one')).toBeNull()
        await mount('one')
        expect(queue.recovered.map(item => item.text)).toEqual(['Replacement'])
        expect(stored('two').text).toBe('Other conversation')
    })
})

describe('review regressions', () => {
    it('keeps the in-flight queue owned until acceptance when another message is queued', async () => {
        await mount()
        await act(async () => queue.enqueue('Already sending', null))
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        await act(async () => queue.enqueue('New follow-up', null))
        expect(queue.queued?.text).toBe('Already sending')
        expect(queue.recovered.map(item => item.text)).toEqual(['New follow-up'])
        await act(async () => finish?.('accepted'))
        expect(queue.queued).toBeNull()
        expect(queue.recovered.map(item => item.text)).toEqual(['New follow-up'])
        expect(queue.recovered[0].uncertain).toBe(false)
    })

    it('does not discard an in-flight message', async () => {
        await mount()
        await act(async () => queue.enqueue('Already sending', null))
        await act(async () => { queue.beginDelivery(queue.queued!.id) })
        await act(async () => queue.clear())
        expect(queue.queued?.text).toBe('Already sending')
        expect(stored().text).toBe('Already sending')
    })

    it('returns failure and exposes a storage warning when queue persistence fails', async () => {
        await mount()
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
        let saved: unknown
        await act(async () => { saved = queue.enqueue('Keep this in the draft', null) })
        expect(saved).toBe(false)
        expect(queue.storageError).toContain('not saved')
        write.mockRestore()
    })

    it('does not turn another tab queue into an automatic send', async () => {
        await mount()
        localStorage.setItem('composer-queued-one', JSON.stringify({ id: 'other-tab', text: 'Written elsewhere', createdAt: 1, behindRunId: null }))
        await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'composer-queued-one' })))
        expect(queue.restoredId).toBe('other-tab')
    })
})


describe('two tabs and storage recovery', () => {
    it('does not let a stale discard remove a new queue written by another hook', async () => {
        let first!: ReturnType<typeof useQueuedMessage>
        let second!: ReturnType<typeof useQueuedMessage>
        function TwoTabs() {
            first = useQueuedMessage('shared')
            second = useQueuedMessage('shared')
            return null
        }
        await act(async () => root.render(createElement(TwoTabs)))
        await act(async () => first.enqueue('First tab', null))
        const staleDiscard = first.clear
        await act(async () => second.enqueue('Second tab', null))
        await act(async () => staleDiscard())
        expect(stored('shared').text).toBe('Second tab')
        await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'composer-queued-shared' })))
        expect(first.queued?.text).toBe('Second tab')
        expect(first.autoSendEligible).toBe(false)
        expect(second.recovered.map(item => item.text)).toContain('First tab')
    })

    it('does not label a failed attempt marker write as an unknown delivery', async () => {
        await mount()
        await act(async () => queue.enqueue('Not submitted', null))
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
        await act(async () => { expect(queue.beginDelivery(queue.queued!.id)).toBeNull() })
        expect(queue.deliveryState).toBe('waiting')
        expect(queue.deliveryBlocked).toBe(false)
        expect(queue.storageError).toContain('not saved')
        write.mockRestore()
    })

    it('only allows an explicit retry after a definitive refusal', async () => {
        await mount()
        await act(async () => queue.enqueue('Try again manually', null))
        let finish!: ReturnType<typeof queue.beginDelivery>
        await act(async () => { finish = queue.beginDelivery(queue.queued!.id) })
        await act(async () => finish?.('rejected'))
        expect(queue.beginDelivery(queue.queued!.id)).toBeNull()
        await act(async () => { expect(queue.beginDelivery(queue.queued!.id, true)).not.toBeNull() })
    })
})

describe('stop request state', () => {
    it('observes another tab stop and does not treat an unknown session fallback as safe', async () => {
        let stop!: ReturnType<typeof useStopRequestState>
        function StopTab() { stop = useStopRequestState('shared'); return null }
        await act(async () => root.render(createElement(StopTab)))
        localStorage.setItem('composer-stopped-shared', JSON.stringify({ id: 'other-stop', runId: null, phase: 'requesting' }))
        await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'composer-stopped-shared' })))
        expect(stop.stop?.phase).toBe('unknown')
        expect(stop.manualAllowed).toBe(false)
        let request!: ReturnType<typeof stop.begin>
        await act(async () => { request = stop.begin('old-run') })
        await act(async () => stop.finish(request, false))
        expect(stop.manualAllowed).toBe(true)
        await act(async () => stop.release(request.id))
        expect(stop.stop).toBeNull()
    })
})
