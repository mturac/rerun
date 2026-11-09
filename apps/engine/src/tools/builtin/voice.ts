import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'

const MAX_TEXT_LENGTH = 4_000
const TTS_UNAVAILABLE = 'tts unavailable: no text-to-speech engine on this host (only macOS `say` is supported)'
const STT_UNAVAILABLE =
    'stt unavailable: no speech-to-text on this host (needs macOS, ffmpeg with avfoundation, whisper-cli and a ggml whisper model)'
const LISTEN_DEFAULT_SECONDS = 5
const LISTEN_MAX_SECONDS = 30
const RECORD_TIMEOUT_SLACK_MS = 20_000
const TRANSCRIBE_TIMEOUT_MS = 180_000
const MODEL_FILE_PATTERN = /^ggml-.*\.bin$/

const MODEL_DIRS = [
    join(homedir(), '.cache', 'whisper'),
    join(homedir(), '.local', 'share', 'local-manus', 'models'),
    '/opt/homebrew/opt/whisper.cpp/share/whisper-cpp',
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp',
    join(process.cwd(), 'models'),
]

function speakWithSay(text: string, voice: string | undefined, rate: number | undefined): Promise<'ok' | 'unavailable' | 'failed'> {
    return new Promise(resolve => {
        const args = ['-v', voice ?? 'Samantha', '-r', String(rate ?? 200)]
        if (text) args.push(text)
        const child = spawn('say', args, { stdio: 'ignore' })
        child.on('error', () => resolve('unavailable'))
        child.on('close', code => resolve(code === 0 ? 'ok' : 'failed'))
    })
}

type RunResult = { code: number | null; stdout: string; stderr: string; error?: Error; timedOut?: boolean }

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
        }, timeoutMs)
        child.stdout?.on('data', chunk => {
            stdout += chunk
        })
        child.stderr?.on('data', chunk => {
            stderr += chunk
        })
        child.on('error', error => {
            clearTimeout(timer)
            resolve({ code: null, stdout, stderr, error })
        })
        child.on('close', code => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr, timedOut })
        })
    })
}

function binaryPath(name: string, override: string | undefined): string {
    if (override) return override
    for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
        if (existsSync(candidate)) return candidate
    }
    return name
}

function modelFilesIn(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter(file => MODEL_FILE_PATTERN.test(file))
            .map(file => join(dir, file))
    } catch {
        return []
    }
}

function findWhisperModel(override: string | undefined): { path?: string; error?: string } {
    if (override) {
        return existsSync(override) ? { path: override } : { error: `whisper model not found at ${override}` }
    }
    const candidates: { path: string; size: number }[] = []
    for (const dir of MODEL_DIRS) {
        const files = [...modelFilesIn(dir)]
        for (const entry of safeReaddir(dir)) {
            if (entry.isDirectory()) files.push(...modelFilesIn(join(dir, entry.name)))
        }
        for (const file of files) {
            try {
                candidates.push({ path: file, size: statSync(file).size })
            } catch {}
        }
    }
    if (candidates.length === 0) return {}
    candidates.sort((a, b) => a.size - b.size)
    return { path: candidates[0].path }
}

function safeReaddir(dir: string): { name: string; isDirectory(): boolean }[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

export function voiceTools(ctx: RunContext): ToolSet {
    const agentEnv = ctx.agent.env ?? {}
    const voice = agentEnv.RERUN_TTS_VOICE || process.env.RERUN_TTS_VOICE || undefined
    const rateRaw = agentEnv.RERUN_TTS_RATE || process.env.RERUN_TTS_RATE
    const rateParsed = rateRaw ? Number(rateRaw) : NaN
    const rate = Number.isFinite(rateParsed) ? Math.min(600, Math.max(1, Math.round(rateParsed))) : undefined

    const ffmpeg = binaryPath('ffmpeg', agentEnv.RERUN_FFMPEG || process.env.RERUN_FFMPEG || undefined)
    const whisperCli = binaryPath('whisper-cli', agentEnv.RERUN_WHISPER_CLI || process.env.RERUN_WHISPER_CLI || undefined)
    const modelOverride = agentEnv.RERUN_WHISPER_MODEL || process.env.RERUN_WHISPER_MODEL || undefined
    const audioDevice = agentEnv.RERUN_LISTEN_DEVICE || process.env.RERUN_LISTEN_DEVICE || '0'

    return {
        speak: tool({
            description:
                'Speak text aloud on the host machine (macOS `say`). Reports tts unavailable where no speech engine exists. Voice and rate come from agent env RERUN_TTS_VOICE and RERUN_TTS_RATE.',
            inputSchema: z.object({
                text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('The text to speak aloud, in the language of the voice.'),
            }),
            execute: async ({ text }) => {
                if (process.platform !== 'darwin') return TTS_UNAVAILABLE
                const result = await speakWithSay(text, voice, rate)
                if (result === 'unavailable') return TTS_UNAVAILABLE
                if (result === 'failed') return 'tts failed: the host speech engine exited with an error.'
                return `Spoke aloud: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`
            },
        }),
        listen: tool({
            description:
                'Record the host microphone for a few seconds and transcribe it locally with whisper.cpp (ffmpeg avfoundation + whisper-cli). Reports stt unavailable where the toolchain or a ggml model is missing. Duration defaults to 5s, capped at 30s; language defaults to auto-detect. Configure with agent env RERUN_WHISPER_MODEL, RERUN_WHISPER_CLI, RERUN_FFMPEG and RERUN_LISTEN_DEVICE.',
            inputSchema: z.object({
                durationSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(LISTEN_MAX_SECONDS)
                    .default(LISTEN_DEFAULT_SECONDS)
                    .describe('How long to record, in seconds (1-30, default 5).'),
                language: z.string().min(2).max(20).optional().describe('Spoken language hint (e.g. "en", "fr"); omit for auto-detect.'),
            }),
            execute: async ({ durationSeconds, language }) => {
                if (process.platform !== 'darwin') return STT_UNAVAILABLE
                const model = findWhisperModel(modelOverride)
                if (model.error) return `stt unavailable: ${model.error}.`
                if (!model.path) return STT_UNAVAILABLE

                const wav = join(tmpdir(), `rerun-listen-${randomUUID()}.wav`)
                try {
                    const record = await runProcess(
                        ffmpeg,
                        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', `:${audioDevice}`, '-ar', '16000', '-ac', '1', '-t', String(durationSeconds), '-f', 'wav', wav],
                        durationSeconds * 1000 + RECORD_TIMEOUT_SLACK_MS,
                    )
                    if (record.error || record.code !== 0 || record.timedOut) {
                        if ((record.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return STT_UNAVAILABLE
                        return 'stt failed: could not record from the host microphone (check microphone permission, the audio device and RERUN_LISTEN_DEVICE).'
                    }
                    const transcribe = await runProcess(
                        whisperCli,
                        ['-m', model.path, '-f', wav, '-l', language ?? 'auto', '-np', '-nt'],
                        TRANSCRIBE_TIMEOUT_MS,
                    )
                    if (transcribe.error || transcribe.code !== 0 || transcribe.timedOut) {
                        if ((transcribe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return STT_UNAVAILABLE
                        return 'stt failed: whisper-cli could not transcribe the recording.'
                    }
                    const transcript = transcribe.stdout.replace(/\s+/g, ' ').trim()
                    if (!transcript) return `Heard nothing in ${durationSeconds}s of audio.`
                    return `Heard: "${transcript}"`
                } finally {
                    await rm(wav, { force: true }).catch(() => {})
                }
            },
        }),
    }
}
