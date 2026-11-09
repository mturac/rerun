// Dictation inserts the transcript where the caret sits rather than dumping it at the end, so a
// message typed before the recording keeps its place. Surrounding text gets breathing room: a
// transcript butted against a word reads as one.
export function insertTranscript(text: string, transcript: string, start: number, end: number): { text: string; caret: number } {
    const before = text.slice(0, start)
    const after = text.slice(end)
    const spoken = transcript.trim()
    if (!spoken) return { text, caret: start }

    const lead = before && !/\s$/.test(before) && !/^\s/.test(spoken) ? ' ' : ''
    const trail = after && !/^\s/.test(after) && !/\s$/.test(spoken) ? ' ' : ''
    const inserted = `${lead}${spoken}${trail}`
    const caret = start + inserted.length
    return { text: `${before}${inserted}${after}`, caret }
}
