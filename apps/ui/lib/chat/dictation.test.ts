import { describe, expect, it } from 'vitest'
import { insertTranscript } from './dictation'

describe('insertTranscript', () => {
    it('replaces the selection', () => {
        expect(insertTranscript('hello world', 'there', 6, 11)).toEqual({ text: 'hello there', caret: 11 })
    })

    it('appends at the caret when nothing is selected', () => {
        expect(insertTranscript('say ', 'hi', 4, 4)).toEqual({ text: 'say hi', caret: 6 })
    })

    it('pads a transcript butted against words on both sides', () => {
        expect(insertTranscript('sayhi', 'there', 3, 3)).toEqual({ text: 'say there hi', caret: 10 })
    })

    it('does not double-space next to existing whitespace', () => {
        expect(insertTranscript('say  ', 'hi', 5, 5)).toEqual({ text: 'say  hi', caret: 7 })
    })

    it('leaves the text alone for an empty transcript', () => {
        expect(insertTranscript('keep', '   ', 2, 2)).toEqual({ text: 'keep', caret: 2 })
    })
})
