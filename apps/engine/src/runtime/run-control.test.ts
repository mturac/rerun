import { describe, expect, it, vi } from 'vitest'
import { abortRun, activeRunCount, agentHasLiveRun, claimSession, registerRunAbort, releaseSession, sessionClaim, sessionClaimCount, setRunCancel, unregisterRunAbort } from './run-control.js'

describe('abortRun', () => {
    it('returns false for a run it never registered', () => {
        expect(abortRun('ghost')).toBe(false)
    })

    it('keeps a cancelled run and its conversation live until settlement unregisters it', () => {
        const before = activeRunCount()
        const controller = registerRunAbort('run-a', 'agent-1')
        const cancel = vi.fn()
        setRunCancel('run-a', cancel)
        expect(claimSession('sess-a', 'run-a')).toBeNull()
        expect(activeRunCount()).toBe(before + 1)

        expect(abortRun('run-a')).toBe(true)

        expect(controller.signal.aborted).toBe(true)
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(sessionClaim('sess-a')?.runId).toBe('run-a')
        expect(claimSession('sess-a', 'next-run')).toBe('run-a')
        expect(activeRunCount()).toBe(before + 1)
        expect(agentHasLiveRun('agent-1')).toBe(true)

        unregisterRunAbort('run-a')

        expect(sessionClaim('sess-a')).toBeNull()
        expect(activeRunCount()).toBe(before)
    })

    it('handles repeated stops until settlement without aborting or cancelling twice', () => {
        const controller = registerRunAbort('run-b', 'agent-1')
        const cancel = vi.fn()
        const onAbort = vi.fn()
        controller.signal.addEventListener('abort', onAbort)
        setRunCancel('run-b', cancel)

        expect(abortRun('run-b')).toBe(true)
        expect(abortRun('run-b')).toBe(true)
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(onAbort).toHaveBeenCalledTimes(1)

        unregisterRunAbort('run-b')
        expect(abortRun('run-b')).toBe(false)
    })

    it('aborts a run that never set a cancel hook', () => {
        const before = activeRunCount()
        const controller = registerRunAbort('run-c', 'agent-1')
        expect(claimSession('sess-c', 'run-c')).toBeNull()
        expect(abortRun('run-c')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
        expect(sessionClaim('sess-c')).toBeNull()
        expect(activeRunCount()).toBe(before)
        expect(abortRun('run-c')).toBe(false)
    })

    it('keeps ownership if its cancellation callback throws', () => {
        const controller = registerRunAbort('run-throw', 'agent-throw')
        const cancel = vi.fn(() => { throw new Error('cleanup failed') })
        claimSession('sess-throw', 'run-throw')
        setRunCancel('run-throw', cancel)

        try {
            expect(() => abortRun('run-throw')).toThrow('cleanup failed')
            expect(abortRun('run-throw')).toBe(true)
            expect(controller.signal.aborted).toBe(true)
            expect(cancel).toHaveBeenCalledTimes(1)
            expect(sessionClaim('sess-throw')?.runId).toBe('run-throw')
            expect(agentHasLiveRun('agent-throw')).toBe(true)
        } finally {
            unregisterRunAbort('run-throw')
        }
    })

    it('handles a stop reentered from the abort signal without calling cancellation twice', () => {
        const controller = registerRunAbort('run-reentrant', 'agent-reentrant')
        const cancel = vi.fn()
        const repeatedStop = vi.fn(() => abortRun('run-reentrant'))
        setRunCancel('run-reentrant', cancel)
        controller.signal.addEventListener('abort', repeatedStop)

        try {
            expect(abortRun('run-reentrant')).toBe(true)
            expect(repeatedStop).toHaveReturnedWith(true)
            expect(cancel).toHaveBeenCalledTimes(1)
        } finally {
            unregisterRunAbort('run-reentrant')
        }
    })

    it('remembers a stop between claiming the conversation and registering its run', () => {
        expect(claimSession('sess-starting', 'run-starting')).toBeNull()
        expect(abortRun('run-starting')).toBe(true)
        expect(abortRun('run-starting')).toBe(true)
        expect(sessionClaim('sess-starting')?.runId).toBe('run-starting')

        const controller = registerRunAbort('run-starting', 'agent-starting')
        const cancel = vi.fn()
        const replacement = vi.fn()
        try {
            expect(controller.signal.aborted).toBe(true)
            setRunCancel('run-starting', cancel)
            setRunCancel('run-starting', replacement)
            expect(abortRun('run-starting')).toBe(true)
            expect(cancel).toHaveBeenCalledTimes(1)
            expect(replacement).not.toHaveBeenCalled()
        } finally {
            unregisterRunAbort('run-starting')
        }
        expect(abortRun('run-starting')).toBe(false)
    })

    it('clears a pending stop when a claimed launch fails before registration', () => {
        expect(claimSession('sess-failed-start', 'run-failed-start')).toBeNull()
        expect(abortRun('run-failed-start')).toBe(true)
        releaseSession('run-failed-start')

        const controller = registerRunAbort('run-failed-start', 'agent-starting')
        try {
            expect(controller.signal.aborted).toBe(false)
        } finally {
            unregisterRunAbort('run-failed-start')
        }
    })
})

describe('setRunCancel', () => {
    it('ignores a run that is not registered', () => {
        const cancel = vi.fn()
        setRunCancel('not-registered', cancel)
        registerRunAbort('not-registered', 'agent-1')
        abortRun('not-registered')
        expect(cancel).not.toHaveBeenCalled()
    })
})

describe('session claims', () => {
    it('does nothing when releasing a run that holds no claim', () => {
        claimSession('sess-held', 'holder')
        const count = sessionClaimCount()

        releaseSession('no-claim')

        expect(sessionClaimCount()).toBe(count)
        expect(sessionClaim('sess-held')?.runId).toBe('holder')
        releaseSession('holder')
    })

    it('records who holds a session and since when', () => {
        const before = Date.now()
        claimSession('sess-time', 'run-t')

        const claim = sessionClaim('sess-time')

        expect(claim?.runId).toBe('run-t')
        expect(claim?.claimedAt).toBeGreaterThanOrEqual(before)
        expect(claim?.claimedAt).toBeLessThanOrEqual(Date.now())
        releaseSession('run-t')
        expect(sessionClaim('sess-time')).toBeNull()
    })

    it('counts claimed sessions', () => {
        const before = sessionClaimCount()
        claimSession('sess-1', 'r1')
        claimSession('sess-2', 'r2')
        claimSession('sess-2', 'r3')

        expect(sessionClaimCount()).toBe(before + 2)

        releaseSession('r1')
        releaseSession('r2')
        expect(sessionClaimCount()).toBe(before)
    })

    it('keeps the holder claim when a refused run releases', () => {
        claimSession('sess-x', 'holder-x')
        expect(claimSession('sess-x', 'refused')).toBe('holder-x')

        releaseSession('refused')

        expect(sessionClaim('sess-x')?.runId).toBe('holder-x')
        releaseSession('holder-x')
    })

    it('unregistering a run frees its claim and drops it from the active count', () => {
        const before = activeRunCount()
        registerRunAbort('run-u', 'agent-1')
        claimSession('sess-u', 'run-u')

        unregisterRunAbort('run-u')

        expect(activeRunCount()).toBe(before)
        expect(sessionClaim('sess-u')).toBeNull()
        expect(abortRun('run-u')).toBe(false)
    })

    it('knows which coworkers have a run live, until it ends or is aborted', () => {
        registerRunAbort('live-1', 'coworker')
        registerRunAbort('live-2', 'coworker')
        expect(agentHasLiveRun('coworker')).toBe(true)
        expect(agentHasLiveRun('someone-else')).toBe(false)

        unregisterRunAbort('live-1')
        expect(agentHasLiveRun('coworker')).toBe(true)
        abortRun('live-2')
        expect(agentHasLiveRun('coworker')).toBe(false)
    })

    it('remembers who started the run holding a conversation', () => {
        claimSession('sess-author', 'run-author', 'u1')
        expect(sessionClaim('sess-author')?.authorId).toBe('u1')
        releaseSession('run-author')
        claimSession('sess-author', 'run-unsigned')
        expect(sessionClaim('sess-author')?.authorId).toBeUndefined()
        releaseSession('run-unsigned')
    })
})
