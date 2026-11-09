import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const STT_UNAVAILABLE =
    'stt unavailable: no speech-to-text on this host (needs ffmpeg, whisper-cli and a ggml whisper model)'

const TRANSCRIBE_TIMEOUT_MS = 180_000
const CONVERT_TIMEOUT_MS = 120_000
const MODEL_FILE_PATTERN = /^ggml-.*\.bin$/

const MODEL_DIRS = [
    join(homedir(), '.cache', 'whisper'),
    join(homedir(), '.local', 'share', 'local-manus', 'models'),
    '/opt/homebrew/opt/whisper.cpp/share/whisper-cpp',
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp',
    join(process.cwd(), 'models'),
]

export type RunResult = { code: number | null; stdout: string; stderr: string; error?: Error; timedOut?: boolean }

export function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
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

export function binaryPath(name: string, override: string | undefined): string {
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

export type SttConfig = {
    ffmpeg: string
    whisperCli: string
    modelPath?: string
    modelError?: string
}

// Agent env wins over the process env, the same precedence the voice tools use, so a per-agent
// RERUN_WHISPER_MODEL or RERUN_FFMPEG override reaches the transcribe route too.
export function resolveStt(agentEnv: Record<string, string> = {}): SttConfig {
    const ffmpeg = binaryPath('ffmpeg', agentEnv.RERUN_FFMPEG || process.env.RERUN_FFMPEG || undefined)
    const whisperCli = binaryPath('whisper-cli', agentEnv.RERUN_WHISPER_CLI || process.env.RERUN_WHISPER_CLI || undefined)
    const modelOverride = agentEnv.RERUN_WHISPER_MODEL || process.env.RERUN_WHISPER_MODEL || undefined
    const model = findWhisperModel(modelOverride)
    return { ffmpeg, whisperCli, modelPath: model.path, modelError: model.error }
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: string; unavailable: boolean }

export type TranscribeOptions = { ffmpeg: string; whisperCli: string; modelPath: string; language?: string }

function enoent(result: RunResult): boolean {
    return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

// The whisper half of transcription, shared by `listen` (which records straight to 16 kHz wav)
// and `transcribeAudio` (which converts any container first). `text` is '' when nothing was heard.
export async function transcribeWav(wavPath: string, opts: Pick<TranscribeOptions, 'whisperCli' | 'modelPath' | 'language'>): Promise<TranscribeResult> {
    const transcribe = await runProcess(opts.whisperCli, ['-m', opts.modelPath, '-f', wavPath, '-l', opts.language ?? 'auto', '-np', '-nt'], TRANSCRIBE_TIMEOUT_MS)
    if (transcribe.error || transcribe.code !== 0 || transcribe.timedOut) {
        if (enoent(transcribe)) return { ok: false, unavailable: true, error: STT_UNAVAILABLE }
        return { ok: false, unavailable: false, error: 'stt failed: whisper-cli could not transcribe the audio.' }
    }
    return { ok: true, text: transcribe.stdout.replace(/\s+/g, ' ').trim() }
}

// Transcribes an audio file in any container ffmpeg reads (webm, mp4/m4a, ogg, wav, mp3, ...).
// ffmpeg normalizes to 16 kHz mono wav in the tmpdir first, which is the only shape whisper-cli
// is fed. Both temp files are removed before returning.
export async function transcribeAudio(inputPath: string, opts: TranscribeOptions): Promise<TranscribeResult> {
    const wav = join(tmpdir(), `rerun-stt-${randomUUID()}.wav`)
    try {
        const convert = await runProcess(opts.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wav], CONVERT_TIMEOUT_MS)
        if (convert.error || convert.code !== 0 || convert.timedOut) {
            if (enoent(convert)) return { ok: false, unavailable: true, error: STT_UNAVAILABLE }
            return { ok: false, unavailable: false, error: 'stt failed: could not decode the audio (ffmpeg).' }
        }
        return await transcribeWav(wav, opts)
    } finally {
        await rm(wav, { force: true }).catch(() => {})
    }
}
