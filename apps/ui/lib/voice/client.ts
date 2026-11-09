import { uploadUrl, type UploadTarget } from '@/lib/files/upload-url'
import { withTabWorkspace } from '@/lib/workspace/tab-workspace'

async function errorFrom(res: Response, fallback: string): Promise<Error> {
    try {
        const payload: unknown = await res.json()
        const message = (payload as { error?: unknown }).error
        if (typeof message === 'string' && message) return new Error(message)
    } catch {
        // A non-JSON body is the normal shape of a proxy-level rejection.
    }
    return new Error(fallback)
}

/** Drops the recording where the conversation keeps its files and returns the path to open it by. */
export async function uploadVoiceRecording({ target, dir, name, blob }: { target: UploadTarget; dir: string; name: string; blob: Blob }): Promise<string> {
    const res = await fetch(uploadUrl(target, dir, name, blob.size), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
    })
    if (!res.ok) throw await errorFrom(res, 'Could not save your voice message.')

    const payload: unknown = await res.json()
    const path = (payload as { path?: unknown }).path
    if (typeof path !== 'string' || !path) throw new Error('Could not save your voice message.')
    return path
}

/**
 * Dictation for the composer: the recording goes to the engine's local whisper.cpp through the
 * agent proxy and the transcript comes back to be inserted into the draft, not sent.
 */
export async function transcribeDictation(agentId: string, blob: Blob, format: string): Promise<string> {
    const res = await fetch(withTabWorkspace(`/api/agents/${encodeURIComponent(agentId)}/voice/transcribe?format=${encodeURIComponent(format)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
    })
    if (!res.ok) throw await errorFrom(res, 'Could not transcribe your dictation.')

    const payload: unknown = await res.json()
    const text = (payload as { text?: unknown }).text
    return typeof text === 'string' ? text.trim() : ''
}

export async function transcribeVoiceRecording(blob: Blob, format: string): Promise<string> {
    const res = await fetch(`/api/voice/transcribe?format=${encodeURIComponent(format)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
    })
    if (!res.ok) throw await errorFrom(res, 'Could not transcribe your voice message.')

    const payload: unknown = await res.json()
    const text = (payload as { text?: unknown }).text
    return typeof text === 'string' ? text.trim() : ''
}
