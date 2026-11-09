import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { agentDir } from '../config/paths.js'
import { codexCommand } from '../runtime/codex-cli.js'
import type { ExternalAgentLaunch, ExternalAgentProvider, ExternalAgentStatus, ExternalAgentTask } from './types.js'

export type CliCommand = { cmd: string; args: string[] }

export type CliProviderOptions = {
    name: string
    agentId: string
    agentEnv: Record<string, string>
    env: NodeJS.ProcessEnv
    command: () => CliCommand
    buildArgs: (input: ExternalAgentLaunch, runDir: string) => string[]
    extraEnvArgs?: string
    spawnImpl?: typeof spawn
    killImpl?: (pid: number, signal: NodeJS.Signals | number) => void
    pidAlive?: (pid: number) => boolean
}

type RunRecord = {
    provider: string
    id: string
    pid: number
    cmd: string
    args: string[]
    cwd: string
    logPath: string
    exitPath: string
    startedAt: string
    status: string
}

const WRAPPER = '"$@" >"$RERUN_LOG" 2>&1; echo $? >"$RERUN_EXIT"'

function binaryExists(command: CliCommand): boolean {
    const bundled = command.args.find(arg => /\.[cm]?js$/i.test(arg))
    const candidate = bundled ?? command.cmd
    if (candidate.includes('/')) return existsSync(candidate)
    try {
        execFileSync('sh', ['-c', `command -v ${candidate}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return true
    } catch {
        return false
    }
}

function defaultPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function delegatePrompt(prompt: string, runDir: string): string {
    return [
        'You are an external coding agent delegated by Rerun, running headless on this machine.',
        `Your working directory is ${runDir}.`,
        'Your final message is the deliverable: end with a concise summary of what you did and anything the delegating agent must know.',
        'Elapsed time is not progress or approval: waiting, polling or a long run never substitutes for doing the work or for the user\'s sign-off.',
        'Back every claim with evidence — files changed, commands run, test output — not assertions.',
        '',
        prompt,
    ].join('\n')
}

function logTail(logPath: string): string | undefined {
    try {
        const tail = readFileSync(logPath, 'utf8').slice(-500).trim()
        return tail || undefined
    } catch {
        return undefined
    }
}

const EVENT_TAIL_BYTES = 64 * 1024
const EVENT_LIMIT = 20

function jsonEvents(logPath: string): unknown[] | undefined {
    try {
        const content = readFileSync(logPath, 'utf8')
        const lines = content.slice(-EVENT_TAIL_BYTES).split('\n')
        const events: unknown[] = []
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('{')) continue
            try {
                events.push(JSON.parse(trimmed))
            } catch {
                // Partial line at the tail boundary or plain-text output mixed in.
            }
        }
        return events.length > 0 ? events.slice(-EVENT_LIMIT) : undefined
    } catch {
        return undefined
    }
}

function eventText(event: unknown): string | undefined {
    if (!event || typeof event !== 'object') return undefined
    const e = event as Record<string, any>
    const item = e.item
    if (item && typeof item === 'object') {
        if (item.type === 'agent_message' && typeof item.text === 'string') return item.text
        if (item.type === 'error') return undefined
    }
    const content = e.message?.content ?? e.content ?? item?.content
    if (Array.isArray(content)) {
        const texts = content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text)
        if (texts.length > 0) return texts.join('')
    }
    for (const key of ['result', 'text', 'output']) {
        if (typeof e[key] === 'string' && e[key].trim()) return e[key]
    }
    if (item && typeof item.text === 'string' && item.text.trim()) return item.text
    return undefined
}

function eventSummary(events: unknown[] | undefined, fallback: string | undefined): string | undefined {
    if (!events) return fallback
    for (let i = events.length - 1; i >= 0; i--) {
        const text = eventText(events[i])
        if (text?.trim()) return text.trim().slice(-500)
    }
    return fallback
}

export function cliProvider(opts: CliProviderOptions): ExternalAgentProvider {
    const { name, agentId, agentEnv, env } = opts
    const spawnImpl = opts.spawnImpl ?? spawn
    const killImpl = opts.killImpl ?? ((pid: number, signal: NodeJS.Signals | number) => process.kill(pid, signal))
    const pidAlive = opts.pidAlive ?? defaultPidAlive

    const runDir = (id: string) => resolve(agentDir(agentId), 'external-runs', id)
    const runJsonPath = (id: string) => join(runDir(id), 'run.json')

    function readRun(id: string): RunRecord {
        return JSON.parse(readFileSync(runJsonPath(id), 'utf8')) as RunRecord
    }

    function toTask(run: RunRecord, status: ExternalAgentStatus, extra: Partial<ExternalAgentTask> = {}): ExternalAgentTask {
        return { provider: run.provider, id: run.id, name: run.id, status, ...extra, raw: run }
    }

    return {
        name,
        isConfigured: () => binaryExists(opts.command()),

        async launch(input: ExternalAgentLaunch) {
            const id = randomUUID()
            const dir = runDir(id)
            mkdirSync(dir, { recursive: true })
            const logPath = join(dir, 'output.log')
            const exitPath = join(dir, 'exit.txt')
            const cli = opts.command()
            const delegated = { ...input, prompt: delegatePrompt(input.prompt, dir) }
            const builtArgs = opts.buildArgs(delegated, dir)
            if (opts.extraEnvArgs) {
                const extra = (agentEnv[opts.extraEnvArgs] || env[opts.extraEnvArgs] || '').split(/\s+/).filter(Boolean)
                builtArgs.push(...extra)
            }
            const child = spawnImpl('sh', ['-c', WRAPPER, 'sh', cli.cmd, ...cli.args, ...builtArgs], {
                cwd: dir,
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, ...agentEnv, RERUN_LOG: logPath, RERUN_EXIT: exitPath },
            })
            child.unref?.()
            const run: RunRecord = {
                provider: name,
                id,
                pid: child.pid ?? -1,
                cmd: cli.cmd,
                args: [...cli.args, ...builtArgs],
                cwd: dir,
                logPath,
                exitPath,
                startedAt: new Date().toISOString(),
                status: 'running',
            }
            writeFileSync(runJsonPath(id), JSON.stringify(run, null, 2))
            return toTask(run, 'running')
        },

        async status(id: string) {
            const run = readRun(id)
            const events = jsonEvents(run.logPath)
            if (existsSync(run.exitPath)) {
                const code = Number.parseInt(readFileSync(run.exitPath, 'utf8').trim(), 10)
                const tail = logTail(run.logPath)
                const summary = eventSummary(events, tail)
                if (code === 0) return toTask(run, 'completed', { ...(summary ? { summary } : {}), ...(events ? { events } : {}) })
                return toTask(run, 'failed', { error: `process exited with code ${Number.isNaN(code) ? 'unknown' : code}`, ...(summary ? { summary } : {}), ...(events ? { events } : {}) })
            }
            if (run.pid > 0 && pidAlive(run.pid)) {
                const tail = logTail(run.logPath)
                return toTask(run, 'running', { ...(events ? { events } : {}), ...(tail && !events ? { summary: tail } : {}) })
            }
            return toTask(run, 'failed', { error: run.pid > 0 ? 'process exited without recording a status (engine may have restarted)' : 'process failed to spawn' })
        },

        async stop(id: string) {
            const run = readRun(id)
            if (run.pid <= 0) return
            try {
                killImpl(-run.pid, 'SIGTERM')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            }
        },
    }
}

export function codexCliProvider(
    agentId: string,
    agentEnv: Record<string, string>,
    env: NodeJS.ProcessEnv = process.env,
    seams: Pick<CliProviderOptions, 'spawnImpl' | 'killImpl' | 'pidAlive'> = {},
): ExternalAgentProvider {
    return cliProvider({
        name: 'codex-cli',
        agentId,
        agentEnv,
        env,
        extraEnvArgs: 'RERUN_CODEX_CLI_ARGS',
        command: () => {
            const override = agentEnv.RERUN_CODEX_CLI_PATH || env.RERUN_CODEX_CLI_PATH
            return override ? { cmd: override, args: [] } : codexCommand()
        },
        buildArgs: input => {
            const model = input.model || agentEnv.RERUN_CODEX_MODEL || env.RERUN_CODEX_MODEL
            return ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"', ...(model ? ['-m', model] : []), input.prompt]
        },
        ...seams,
    })
}

export function cursorCliProvider(
    agentId: string,
    agentEnv: Record<string, string>,
    env: NodeJS.ProcessEnv = process.env,
    seams: Pick<CliProviderOptions, 'spawnImpl' | 'killImpl' | 'pidAlive'> = {},
): ExternalAgentProvider {
    return cliProvider({
        name: 'cursor-cli',
        agentId,
        agentEnv,
        env,
        extraEnvArgs: 'RERUN_CURSOR_CLI_ARGS',
        command: () => {
            const override = agentEnv.RERUN_CURSOR_CLI_PATH || env.RERUN_CURSOR_CLI_PATH
            return override ? { cmd: override, args: [] } : { cmd: 'cursor-agent', args: [] }
        },
        buildArgs: input => {
            const model = input.model || agentEnv.RERUN_CURSOR_MODEL || env.RERUN_CURSOR_MODEL
            return ['-p', '--output-format', 'stream-json', '--force', '--trust', ...(model ? ['--model', model] : []), input.prompt]
        },
        ...seams,
    })
}

export function claudeCliProvider(
    agentId: string,
    agentEnv: Record<string, string>,
    env: NodeJS.ProcessEnv = process.env,
    seams: Pick<CliProviderOptions, 'spawnImpl' | 'killImpl' | 'pidAlive'> = {},
): ExternalAgentProvider {
    return cliProvider({
        name: 'claude-cli',
        agentId,
        agentEnv,
        env,
        extraEnvArgs: 'RERUN_CLAUDE_CLI_ARGS',
        command: () => {
            const override = agentEnv.RERUN_CLAUDE_CLI_PATH || env.RERUN_CLAUDE_CLI_PATH
            return override ? { cmd: override, args: [] } : { cmd: 'claude', args: [] }
        },
        buildArgs: input => {
            const model = input.model || agentEnv.RERUN_CLAUDE_MODEL || env.RERUN_CLAUDE_MODEL
            return ['-p', input.prompt, '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : [])]
        },
        ...seams,
    })
}
