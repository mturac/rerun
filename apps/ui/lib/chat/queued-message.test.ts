import { describe, expect, it } from 'vitest'
import { appendAttachmentsRef, buildAttachmentsRef } from './attachments-marker'
import { canAttemptAfterStop, messageAcceptance, parseQueued, queuedPreview, shouldFlush, shouldKeepQueued, type QueuedMessage } from './queued-message'

const queued: QueuedMessage = { id: 'q1', text: 'Ship it', createdAt: 1_757_000_000_000, behindRunId: 'run-1' }

describe('parseQueued', () => {
    it('round-trips what the hook stored', () => {
        expect(parseQueued(JSON.stringify(queued))).toEqual(queued)
    })

    it('accepts a message queued without a known run', () => {
        expect(parseQueued(JSON.stringify({ ...queued, behindRunId: null }))?.behindRunId).toBeNull()
    })

    it.each([
        ['nothing stored', null],
        ['broken json', '{'],
        ['an empty object', '{}'],
        ['an array', '[]'],
        ['a blank text', JSON.stringify({ ...queued, text: '   ' })],
        ['a missing id', JSON.stringify({ ...queued, id: '' })],
        ['a createdAt that is not a number', JSON.stringify({ ...queued, createdAt: 'now' })],
        ['a behindRunId that is not a string', JSON.stringify({ ...queued, behindRunId: 3 })],
    ])('returns null on %s', (_label, raw) => {
        expect(parseQueued(raw)).toBeNull()
    })
})

describe('queuedPreview', () => {
    it('reads a plain message as is', () => {
        expect(queuedPreview('Ship it')).toEqual({ text: 'Ship it', attachments: [] })
    })

    it('drops the attachments marker and un-prefixes the file names', () => {
        const text = appendAttachmentsRef('Look at this', buildAttachmentsRef(['chat-uploads/mtr4k52x-lBg1lF-shot.png']))
        expect(queuedPreview(text)).toEqual({ text: 'Look at this', attachments: ['shot.png'] })
    })

    it('survives a message that is only attachments', () => {
        const text = appendAttachmentsRef('', buildAttachmentsRef(['chat-uploads/mtr4k52x-lBg1lF-report.pdf']))
        expect(queuedPreview(text)).toEqual({ text: '', attachments: ['report.pdf'] })
    })

    it('drops a voice marker', () => {
        expect(queuedPreview('Said out loud\n\n<voice src="a.webm" ms="1200" peaks="AAA">').text).toBe('Said out loud')
    })
})

describe('shouldKeepQueued', () => {
    it('keeps it while the same run is still holding the conversation', () => {
        expect(shouldKeepQueued(queued, 'run-1')).toBe(true)
    })

    it('lets it go once another run holds the conversation', () => {
        expect(shouldKeepQueued(queued, 'run-2')).toBe(false)
    })

    it('lets it go when nothing is running', () => {
        expect(shouldKeepQueued(queued, null)).toBe(false)
    })

    it('lets go a message queued without a known run', () => {
        expect(shouldKeepQueued({ ...queued, behindRunId: null }, null)).toBe(false)
    })
})

describe('shouldFlush', () => {
    const free = { queued, busy: false, uploading: false, status: 'ready', hasError: false }

    it('sends once the conversation is free', () => {
        expect(shouldFlush(free)).toBe(true)
    })

    it.each([
        ['nothing is queued', { queued: null }],
        ['a run still holds the conversation', { busy: true }],
        ['an attachment is still uploading', { uploading: true }],
        ['this tab is streaming', { status: 'streaming' }],
        ['this tab just submitted', { status: 'submitted' }],
        ['the run ended on an error', { hasError: true }],
    ])('waits while %s', (_label, override) => {
        expect(shouldFlush({ ...free, ...override })).toBe(false)
    })
})


describe('messageAcceptance', () => {
    it('requires a successful engine response with a run identity', () => {
        expect(messageAcceptance(new Response(null, { headers: { 'X-Run-Id': 'run-1' } }))).toBe('accepted')
        expect(messageAcceptance(new Response(null))).toBe('uncertain')
        expect(messageAcceptance(new Response(null, { status: 500, headers: { 'X-Run-Id': 'run-1' } }))).toBe('uncertain')
        expect(messageAcceptance(new Response(null, { status: 409 }))).toBe('rejected')
    })
    it('accepts a successful hub response without an engine run', () => {
        expect(messageAcceptance(new Response(null), false)).toBe('accepted')
    })
})


describe('definitive refusal classification', () => {
    it.each([400, 401, 402, 403, 404, 409, 413])('classifies HTTP %s as rejected without implying acceptance', status => {
        expect(messageAcceptance(new Response(null, { status }))).toBe('rejected')
    })
    it.each([500, 502, 503])('leaves HTTP %s ambiguous', status => {
        expect(messageAcceptance(new Response(null, { status }))).toBe('uncertain')
    })
})


describe('manual admission after stop', () => {
    it('does not bypass a session-wide ACK without a captured run identity', () => {
        expect(canAttemptAfterStop({ id: 'stop-1', runId: null, phase: 'acknowledged' })).toBe(false)
        expect(canAttemptAfterStop({ id: 'stop-1', runId: null, phase: 'unknown' })).toBe(false)
    })
    it('permits an explicit attempt for a captured run only after the stop request returns', () => {
        expect(canAttemptAfterStop({ id: 'stop-1', runId: 'old-run', phase: 'requesting' })).toBe(false)
        expect(canAttemptAfterStop({ id: 'stop-1', runId: 'old-run', phase: 'acknowledged' })).toBe(true)
        expect(canAttemptAfterStop({ id: 'stop-1', runId: 'old-run', phase: 'unknown' })).toBe(true)
    })
})


describe('ambiguous HTTP responses', () => {
    it.each([408, 429, 499])('does not treat HTTP %s as proof that nothing was accepted', status => {
        expect(messageAcceptance(new Response(null, { status }))).toBe('uncertain')
    })
    it('keeps a failed response carrying a run identity ambiguous', () => {
        expect(messageAcceptance(new Response(null, { status: 400, headers: { 'X-Run-Id': 'possibly-accepted' } }))).toBe('uncertain')
    })
})
