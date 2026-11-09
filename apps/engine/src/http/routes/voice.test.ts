import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-voice-route-'))
process.env.RERUN_API_KEY = ''

const state = vi.hoisted(() => ({
    modes: {} as Record<string, 'ok' | 'enoent' | 'failed'>,
    transcript: 'dictated text',
}))

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        spawn: (cmd: string, args: string[]) => {
        const child = new EventEmitter() as EventEmitter & { kill(): void; stdout: EventEmitter; stderr: EventEmitter }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => {}
        queueMicrotask(() => {
            const name = cmd.split('/').pop()!
            const mode = state.modes[name] ?? state.modes[cmd] ?? 'ok'
            if (mode === 'enoent') {
                child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }))
                return
            }
            if (name === 'whisper-cli' && mode === 'ok') child.stdout.emit('data', state.transcript)
            child.emit('close', mode === 'failed' ? 1 : 0)
        })
        return child
        },
    }
})

const { describe, expect, it, beforeAll, beforeEach, afterEach } = await import('vitest')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir } = await import('../../config/paths.js')

const id = 'voiceagent'
const app = createServer()
const modelPath = resolve(process.env.RERUN_DATA_DIR!, 'ggml-test.bin')
writeFileSync(modelPath, 'fake model')

beforeAll(async () => {
    await import('node:fs/promises').then(fs => fs.mkdir(agentDir(id), { recursive: true }))
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'voice' }))
})

beforeEach(() => {
    state.modes = {}
    state.transcript = 'dictated text'
    process.env.RERUN_WHISPER_MODEL = modelPath
    process.env.RERUN_WHISPER_CLI = 'whisper-cli'
    process.env.RERUN_FFMPEG = 'ffmpeg'
})

afterEach(() => {
    delete process.env.RERUN_WHISPER_MODEL
    delete process.env.RERUN_WHISPER_CLI
    delete process.env.RERUN_FFMPEG
})

function post(path: string, body: BodyInit | null, headers: Record<string, string> = {}) {
    return app.request(path, { method: 'POST', body, headers })
}

describe('POST /agents/:id/voice/transcribe', () => {
    it('answers 404 for an agent that does not exist', async () => {
        const res = await post('/agents/ghost/voice/transcribe?format=webm', new Uint8Array([1, 2, 3]))
        expect(res.status).toBe(404)
    })

    it('transcribes an uploaded recording and returns the text', async () => {
        const res = await post(`/agents/${id}/voice/transcribe?format=webm`, new Uint8Array([9, 9, 9]), { 'content-type': 'audio/webm' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, text: 'dictated text' })
    })

    it('falls back to the content type when no format is given', async () => {
        const res = await post(`/agents/${id}/voice/transcribe`, new Uint8Array([1]), { 'content-type': 'audio/ogg;codecs=opus' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, text: 'dictated text' })
    })

    it('rejects an empty body', async () => {
        const res = await post(`/agents/${id}/voice/transcribe?format=webm`, new Uint8Array(0))
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ ok: false, error: 'empty audio' })
    })

    it('rejects an oversized upload', async () => {
        const res = await post(`/agents/${id}/voice/transcribe?format=webm`, new Uint8Array(15 * 1024 * 1024 + 1))
        expect(res.status).toBe(413)
    })

    it('answers 503 when no whisper model is configured', async () => {
        process.env.RERUN_WHISPER_MODEL = '/nonexistent/ggml-none.bin'
        const res = await post(`/agents/${id}/voice/transcribe?format=webm`, new Uint8Array([1]))
        expect(res.status).toBe(503)
        const body = (await res.json()) as { ok: boolean; error: string }
        expect(body.ok).toBe(false)
        expect(body.error).toContain('stt unavailable')
    })

    it('answers 503 when the stt toolchain is missing', async () => {
        state.modes = { ffmpeg: 'enoent' }
        const res = await post(`/agents/${id}/voice/transcribe?format=webm`, new Uint8Array([1]))
        expect(res.status).toBe(503)
        expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
    })

    it('answers 502 when transcription fails', async () => {
        state.modes = { 'whisper-cli': 'failed' }
        const res = await post(`/agents/${id}/voice/transcribe?format=webm`, new Uint8Array([1]))
        expect(res.status).toBe(502)
        const body = (await res.json()) as { ok: boolean; error: string }
        expect(body.ok).toBe(false)
        expect(body.error).toContain('stt failed')
    })
})
