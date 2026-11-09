import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-voice-tool-'))
process.env.RERUN_API_KEY = ''

const state = vi.hoisted(() => ({
    calls: [] as { cmd: string; args: string[] }[],
    mode: 'ok' as 'ok' | 'enoent' | 'failed',
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
            const mode = state.modes[name] ?? state.modes[cmd] ?? state.mode
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
const { voiceTools } = await import('./voice.js')

let platformSpy: ReturnType<typeof vi.spyOn> | null = null

function setPlatform(platform: NodeJS.Platform) {
    platformSpy?.mockRestore()
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
}

function speak(agentEnv: Record<string, string> = {}, text = 'hello there') {
    const ctx = { agent: { id: 'voice-agent', env: agentEnv } } as any
    const tool = voiceTools(ctx).speak as any
    return tool.execute(tool.inputSchema.parse({ text }), { toolCallId: 'c', messages: [] }) as Promise<string>
}

const modelPath = join(process.env.RERUN_DATA_DIR!, 'ggml-test.bin')
writeFileSync(modelPath, 'fake model')

function listen(agentEnv: Record<string, string> = {}, input: Record<string, unknown> = {}) {
    const ctx = { agent: { id: 'voice-agent', env: { RERUN_WHISPER_MODEL: modelPath, ...agentEnv } } } as any
    const tool = voiceTools(ctx).listen as any
    return tool.execute(tool.inputSchema.parse(input), { toolCallId: 'c', messages: [] }) as Promise<string>
}

beforeEach(() => {
    state.calls.length = 0
    state.mode = 'ok'
    state.modes = {}
    state.transcript = 'hello there'
    setPlatform('darwin')
})

afterEach(() => {
    platformSpy?.mockRestore()
    platformSpy = null
})

describe('speak', () => {
    it('speaks through macOS say and reports what it said', async () => {
        expect(await speak()).toBe('Spoke aloud: "hello there"')
        expect(state.calls).toEqual([{ cmd: 'say', args: ['-v', 'Samantha', '-r', '200', 'hello there'] }])
    })

    it('honours RERUN_TTS_VOICE and RERUN_TTS_RATE from the agent env before process env', async () => {
        process.env.RERUN_TTS_VOICE = 'process-voice'
        process.env.RERUN_TTS_RATE = '111'
        await speak({ RERUN_TTS_VOICE: 'agent-voice', RERUN_TTS_RATE: '250' })
        expect(state.calls[0].args).toEqual(['-v', 'agent-voice', '-r', '250', 'hello there'])
        state.calls.length = 0
        await speak({})
        expect(state.calls[0].args).toEqual(['-v', 'process-voice', '-r', '111', 'hello there'])
        delete process.env.RERUN_TTS_VOICE
        delete process.env.RERUN_TTS_RATE
    })

    it('clamps an out-of-range rate', async () => {
        await speak({ RERUN_TTS_RATE: '9999' })
        expect(state.calls[0].args).toContain('600')
        state.calls.length = 0
        await speak({ RERUN_TTS_RATE: 'nope' })
        expect(state.calls[0].args).toContain('200')
    })

    it('reports tts unavailable off macOS without spawning', async () => {
        setPlatform('linux')
        expect(await speak()).toBe('tts unavailable: no text-to-speech engine on this host (only macOS `say` is supported)')
        expect(state.calls).toEqual([])
    })

    it('reports tts unavailable when the say binary is missing', async () => {
        state.mode = 'enoent'
        expect(await speak()).toBe('tts unavailable: no text-to-speech engine on this host (only macOS `say` is supported)')
    })

    it('reports a failure when say exits non-zero', async () => {
        state.mode = 'failed'
        expect(await speak()).toBe('tts failed: the host speech engine exited with an error.')
    })
})

describe('listen', () => {
    it('records with ffmpeg avfoundation and transcribes with whisper-cli', async () => {
        expect(await listen()).toBe('Heard: "hello there"')
        const ffmpegCall = state.calls.find(c => c.cmd.includes('ffmpeg'))!
        expect(ffmpegCall.args).toEqual(
            expect.arrayContaining(['-f', 'avfoundation', '-i', ':0', '-ar', '16000', '-ac', '1', '-t', '5', '-f', 'wav']),
        )
        expect(ffmpegCall.args.at(-1)).toMatch(/rerun-listen-.*\.wav$/)
        const whisperCall = state.calls.find(c => c.cmd.includes('whisper-cli'))!
        expect(whisperCall.args).toEqual(expect.arrayContaining(['-m', modelPath, '-l', 'auto', '-np', '-nt']))
        expect(whisperCall.args[whisperCall.args.indexOf('-f') + 1]).toBe(ffmpegCall.args.at(-1))
    })

    it('honours duration, language, model, device and binary overrides', async () => {
        await listen(
            { RERUN_WHISPER_MODEL: modelPath, RERUN_LISTEN_DEVICE: '2', RERUN_FFMPEG: '/opt/homebrew/bin/ffmpeg', RERUN_WHISPER_CLI: '/opt/homebrew/bin/whisper-cli' },
            { durationSeconds: 12, language: 'fr' },
        )
        const ffmpegCall = state.calls.find(c => c.cmd === '/opt/homebrew/bin/ffmpeg')!
        expect(ffmpegCall.args).toEqual(expect.arrayContaining(['-i', ':2', '-t', '12']))
        const whisperCall = state.calls.find(c => c.cmd === '/opt/homebrew/bin/whisper-cli')!
        expect(whisperCall.args).toEqual(expect.arrayContaining(['-l', 'fr']))
    })

    it('caps the recording duration at 30 seconds and defaults to 5', () => {
        const ctx = { agent: { id: 'voice-agent', env: { RERUN_WHISPER_MODEL: modelPath } } } as any
        const tool = voiceTools(ctx).listen as any
        expect(() => tool.inputSchema.parse({ durationSeconds: 45 })).toThrow()
        expect(tool.inputSchema.parse({}).durationSeconds).toBe(5)
        expect(tool.inputSchema.parse({ durationSeconds: 30 }).durationSeconds).toBe(30)
    })

    it('reports stt unavailable off macOS without spawning', async () => {
        setPlatform('linux')
        expect(await listen()).toContain('stt unavailable')
        expect(state.calls).toEqual([])
    })

    it('reports stt unavailable when the configured model is missing', async () => {
        expect(await listen({ RERUN_WHISPER_MODEL: '/nonexistent/ggml-none.bin' })).toBe(
            'stt unavailable: whisper model not found at /nonexistent/ggml-none.bin.',
        )
        expect(state.calls).toEqual([])
    })

    it('reports stt unavailable when ffmpeg is missing', async () => {
        state.modes = { ffmpeg: 'enoent' }
        expect(await listen()).toContain('stt unavailable')
        expect(state.calls.map(c => c.cmd)).toEqual([expect.stringContaining('ffmpeg')])
    })

    it('reports stt unavailable when whisper-cli is missing', async () => {
        state.modes = { 'whisper-cli': 'enoent' }
        expect(await listen()).toContain('stt unavailable')
    })

    it('reports a failure when recording fails', async () => {
        state.modes = { ffmpeg: 'failed' }
        expect(await listen()).toBe(
            'stt failed: could not record from the host microphone (check microphone permission, the audio device and RERUN_LISTEN_DEVICE).',
        )
        expect(state.calls.map(c => c.cmd)).toEqual([expect.stringContaining('ffmpeg')])
    })

    it('reports a failure when transcription fails', async () => {
        state.modes = { 'whisper-cli': 'failed' }
        expect(await listen()).toBe('stt failed: whisper-cli could not transcribe the recording.')
    })

    it('reports an empty transcript as hearing nothing', async () => {
        state.transcript = '  \n  '
        expect(await listen()).toBe('Heard nothing in 5s of audio.')
    })
})
