import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentExists } from '../../agents/loader.js'
import { readAgentEnv } from '../../agents/env.js'
import { resolveStt, transcribeAudio, STT_UNAVAILABLE } from '../../lib/stt.js'

export const voiceRoutes = new Hono()

// 30 s of 32 kbps opus is ~120 KB; the cap only exists to keep a stray upload from
// occupying the engine's tmpdir and whisper's attention.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024

// `?format=` carries the recorder's extension (webm, m4a, ogg, ...); the Content-Type is the
// fallback for clients that do not send it. ffmpeg probes the bytes either way — the extension
// only names the tmp file.
const FORMAT_EXTENSIONS: Record<string, string> = {
    webm: 'webm',
    m4a: 'm4a',
    mp4: 'm4a',
    aac: 'aac',
    wav: 'wav',
    wave: 'wav',
    ogg: 'ogg',
    opus: 'ogg',
    mp3: 'mp3',
    mpeg: 'mp3',
    flac: 'flac',
}

const MIME_TO_FORMAT: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
}

function safeExtension(raw: string | undefined): string {
    if (!raw) return 'webm'
    const token = raw.trim().toLowerCase().replace(/^audio\//, '').split(';')[0].split('/').pop() ?? ''
    return FORMAT_EXTENSIONS[token] ?? (/^[a-z0-9]{1,8}$/.test(token) ? token : 'webm')
}

voiceRoutes.post('/transcribe', async c => {
    const agentId = c.req.param('id')!
    if (!agentExists(agentId)) return c.json({ error: 'agent not found' }, 404)

    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_AUDIO_BYTES) return c.json({ ok: false, error: 'audio too large' }, 413)

    const audio = new Uint8Array(await c.req.arrayBuffer())
    if (audio.byteLength === 0) return c.json({ ok: false, error: 'empty audio' }, 400)
    if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ ok: false, error: 'audio too large' }, 413)

    const format = c.req.query('format') ?? MIME_TO_FORMAT[(c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()] ?? ''
    const ext = safeExtension(format)

    const input = join(tmpdir(), `rerun-stt-upload-${randomUUID()}.${ext}`)
    try {
        await writeFile(input, audio)
        const stt = resolveStt(await readAgentEnv(agentId))
        if (stt.modelError) return c.json({ ok: false, error: `stt unavailable: ${stt.modelError}` }, 503)
        if (!stt.modelPath) return c.json({ ok: false, error: STT_UNAVAILABLE }, 503)

        const language = c.req.query('language') || undefined
        const result = await transcribeAudio(input, { ffmpeg: stt.ffmpeg, whisperCli: stt.whisperCli, modelPath: stt.modelPath, language })
        if (!result.ok) {
            return c.json({ ok: false, error: result.error }, result.unavailable ? 503 : 502)
        }
        return c.json({ ok: true, text: result.text })
    } finally {
        await rm(input, { force: true }).catch(() => {})
    }
})
