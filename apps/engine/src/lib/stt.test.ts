import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-stt-'))

const state = vi.hoisted(() => ({
    calls: [] as { cmd: string; args: string[] }[],
    modes: {} as Record<string, 'ok' | 'enoent' | 'failed'>,
    transcript: 'hello there',
}))

vi.mock('node:child_process', () => ({
    spawn: (cmd: string, args: string[]) => {
        state.calls.push({ cmd, args })
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
}))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const { resolveStt, transcribeAudio, transcribeWav, STT_UNAVAILABLE } = await import('./stt.js')

const modelPath = join(process.env.RERUN_DATA_DIR!, 'ggml-test.bin')
writeFileSync(modelPath, 'fake model')

const opts = { ffmpeg: 'ffmpeg', whisperCli: 'whisper-cli', modelPath }

beforeEach(() => {
    state.calls.length = 0
    state.modes = {}
    state.transcript = 'hello there'
    delete process.env.RERUN_WHISPER_MODEL
    delete process.env.RERUN_WHISPER_CLI
    delete process.env.RERUN_FFMPEG
})

afterEach(() => {
    delete process.env.RERUN_WHISPER_MODEL
    delete process.env.RERUN_WHISPER_CLI
    delete process.env.RERUN_FFMPEG
})

describe('resolveStt', () => {
    it('prefers the agent env over the process env', () => {
        process.env.RERUN_FFMPEG = '/proc/ffmpeg'
        process.env.RERUN_WHISPER_MODEL = modelPath
        const stt = resolveStt({ RERUN_FFMPEG: '/agent/ffmpeg', RERUN_WHISPER_MODEL: modelPath })
        expect(stt.ffmpeg).toBe('/agent/ffmpeg')
        expect(stt.modelPath).toBe(modelPath)
        expect(stt.modelError).toBeUndefined()
    })

    it('reports a missing configured model instead of scanning', () => {
        const stt = resolveStt({ RERUN_WHISPER_MODEL: '/nonexistent/ggml-none.bin' })
        expect(stt.modelPath).toBeUndefined()
        expect(stt.modelError).toBe('whisper model not found at /nonexistent/ggml-none.bin')
    })
})

describe('transcribeAudio', () => {
    it('converts any input to 16 kHz mono wav, then transcribes it', async () => {
        const input = join(process.env.RERUN_DATA_DIR!, 'clip.webm')
        writeFileSync(input, 'fake webm')
        const result = await transcribeAudio(input, opts)
        expect(result).toEqual({ ok: true, text: 'hello there' })

        const convert = state.calls.find(c => c.cmd === 'ffmpeg')!
        expect(convert.args).toEqual(expect.arrayContaining(['-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav']))
        const wav = convert.args.at(-1)!
        expect(wav).toMatch(/rerun-stt-.*\.wav$/)

        const whisper = state.calls.find(c => c.cmd === 'whisper-cli')!
        expect(whisper.args).toEqual(expect.arrayContaining(['-m', modelPath, '-l', 'auto', '-np', '-nt']))
        expect(whisper.args[whisper.args.indexOf('-f') + 1]).toBe(wav)
    })

    it('honours a language hint', async () => {
        await transcribeAudio('/tmp/a.ogg', { ...opts, language: 'fr' })
        const whisper = state.calls.find(c => c.cmd === 'whisper-cli')!
        expect(whisper.args).toEqual(expect.arrayContaining(['-l', 'fr']))
    })

    it('reports unavailable when ffmpeg is missing', async () => {
        state.modes = { ffmpeg: 'enoent' }
        const result = await transcribeAudio('/tmp/a.webm', opts)
        expect(result).toEqual({ ok: false, unavailable: true, error: STT_UNAVAILABLE })
        expect(state.calls.map(c => c.cmd)).toEqual(['ffmpeg'])
    })

    it('reports unavailable when whisper-cli is missing', async () => {
        state.modes = { 'whisper-cli': 'enoent' }
        const result = await transcribeAudio('/tmp/a.webm', opts)
        expect(result).toEqual({ ok: false, unavailable: true, error: STT_UNAVAILABLE })
    })

    it('reports a decode failure when ffmpeg exits non-zero', async () => {
        state.modes = { ffmpeg: 'failed' }
        const result = await transcribeAudio('/tmp/a.webm', opts)
        expect(result).toEqual({ ok: false, unavailable: false, error: 'stt failed: could not decode the audio (ffmpeg).' })
    })

    it('reports a transcription failure when whisper-cli exits non-zero', async () => {
        state.modes = { 'whisper-cli': 'failed' }
        const result = await transcribeAudio('/tmp/a.webm', opts)
        expect(result).toEqual({ ok: false, unavailable: false, error: 'stt failed: whisper-cli could not transcribe the audio.' })
    })

    it('returns an empty transcript rather than an error', async () => {
        state.transcript = '  \n  '
        const result = await transcribeAudio('/tmp/a.webm', opts)
        expect(result).toEqual({ ok: true, text: '' })
    })
})

describe('transcribeWav', () => {
    it('skips conversion and feeds the wav straight to whisper-cli', async () => {
        const wav = join(process.env.RERUN_DATA_DIR!, 'already.wav')
        writeFileSync(wav, 'wav')
        const result = await transcribeWav(wav, { whisperCli: 'whisper-cli', modelPath })
        expect(result).toEqual({ ok: true, text: 'hello there' })
        expect(state.calls.map(c => c.cmd)).toEqual(['whisper-cli'])
    })
})
