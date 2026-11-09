import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { resolveStt, runProcess, STT_UNAVAILABLE, transcribeWav } from '../../lib/stt.js'

const MAX_TEXT_LENGTH = 4_000
const TTS_UNAVAILABLE = 'tts unavailable: no text-to-speech engine on this host (only macOS `say` is supported)'
const LISTEN_DEFAULT_SECONDS = 5
const LISTEN_MAX_SECONDS = 30
const RECORD_TIMEOUT_SLACK_MS = 20_000

function speakWithSay(text: string, voice: string | undefined, rate: number | undefined): Promise<'ok' | 'unavailable' | 'failed'> {
    return new Promise(resolve => {
        const args = ['-v', voice ?? 'Samantha', '-r', String(rate ?? 200)]
        if (text) args.push(text)
        const child = spawn('say', args, { stdio: 'ignore' })
        child.on('error', () => resolve('unavailable'))
        child.on('close', code => resolve(code === 0 ? 'ok' : 'failed'))
    })
}

export function voiceTools(ctx: RunContext): ToolSet {
    const agentEnv = ctx.agent.env ?? {}
    const voice = agentEnv.RERUN_TTS_VOICE || process.env.RERUN_TTS_VOICE || undefined
    const rateRaw = agentEnv.RERUN_TTS_RATE || process.env.RERUN_TTS_RATE
    const rateParsed = rateRaw ? Number(rateRaw) : NaN
    const rate = Number.isFinite(rateParsed) ? Math.min(600, Math.max(1, Math.round(rateParsed))) : undefined

    const stt = resolveStt(agentEnv)
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
                if (stt.modelError) return `stt unavailable: ${stt.modelError}.`
                if (!stt.modelPath) return STT_UNAVAILABLE

                const wav = join(tmpdir(), `rerun-listen-${randomUUID()}.wav`)
                try {
                    const record = await runProcess(
                        stt.ffmpeg,
                        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', `:${audioDevice}`, '-ar', '16000', '-ac', '1', '-t', String(durationSeconds), '-f', 'wav', wav],
                        durationSeconds * 1000 + RECORD_TIMEOUT_SLACK_MS,
                    )
                    if (record.error || record.code !== 0 || record.timedOut) {
                        if ((record.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return STT_UNAVAILABLE
                        return 'stt failed: could not record from the host microphone (check microphone permission, the audio device and RERUN_LISTEN_DEVICE).'
                    }
                    const transcribe = await transcribeWav(wav, { whisperCli: stt.whisperCli, modelPath: stt.modelPath, language })
                    if (!transcribe.ok) {
                        if (transcribe.unavailable) return STT_UNAVAILABLE
                        return 'stt failed: whisper-cli could not transcribe the recording.'
                    }
                    if (!transcribe.text) return `Heard nothing in ${durationSeconds}s of audio.`
                    return `Heard: "${transcribe.text}"`
                } finally {
                    await rm(wav, { force: true }).catch(() => {})
                }
            },
        }),
    }
}
