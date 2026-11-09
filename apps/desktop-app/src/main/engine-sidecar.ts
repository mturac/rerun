import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopConfig } from './config.js'

export type EngineState = 'starting' | 'ready' | 'restarting' | 'stopped' | 'failed'

export interface EngineLaunch {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
}

const here = fileURLToPath(new URL('.', import.meta.url))
const ENGINE_DIR = resolve(here, '../../../engine')
const TSX_ENTRY = join('node_modules', 'tsx', 'dist', 'cli.mjs')

export function resolveEngineLaunch(config: DesktopConfig): EngineLaunch {
    const override = process.env.DESKTOP_ENGINE_CMD
    if (override) {
        const [command, ...args] = override.split(/\s+/).filter(Boolean)
        if (!command) throw new Error('DESKTOP_ENGINE_CMD is empty')
        return { command, args, cwd: ENGINE_DIR, env: engineEnv(config) }
    }
    const packagedEntry = join(process.resourcesPath ?? '', 'engine-dist', 'cli', 'bin.js')
    if (process.resourcesPath && existsSync(packagedEntry)) {
        return { command: process.execPath, args: [packagedEntry, 'run'], cwd: join(process.resourcesPath, 'engine-dist'), env: { ...engineEnv(config), ELECTRON_RUN_AS_NODE: '1' } }
    }
    const distEntry = join(ENGINE_DIR, 'dist', 'cli', 'bin.js')
    const env = { ...engineEnv(config), ELECTRON_RUN_AS_NODE: '1' }
    if (existsSync(distEntry)) {
        return { command: process.execPath, args: [distEntry, 'run'], cwd: ENGINE_DIR, env }
    }
    const tsxEntry = join(ENGINE_DIR, TSX_ENTRY)
    if (existsSync(tsxEntry)) {
        return { command: process.execPath, args: [tsxEntry, 'src/cli/bin.ts', 'run'], cwd: ENGINE_DIR, env }
    }
    throw new Error(`No engine entry found: build apps/engine or set DESKTOP_ENGINE_CMD (looked in ${ENGINE_DIR})`)
}

function engineEnv(config: DesktopConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        RERUN_HOST: '127.0.0.1',
        RERUN_PORT: String(config.enginePort),
        RERUN_API_KEY: config.engineApiKey,
        RERUN_DATA_DIR: config.engineDataDir,
        RERUN_LOG_LEVEL: process.env.RERUN_LOG_LEVEL ?? 'info',
        RERUN_HUB_BASE_URL: process.env.RERUN_HUB_BASE_URL ?? config.uiUrl,
    }
    if (process.env.RERUN_PAIR_TOKEN) env.RERUN_PAIR_TOKEN = process.env.RERUN_PAIR_TOKEN
    if (process.env.RERUN_HUB_URL) env.RERUN_HUB_URL = process.env.RERUN_HUB_URL
    if (process.env.RERUN_DESKTOP) env.RERUN_DESKTOP = process.env.RERUN_DESKTOP
    return env
}

export function engineBaseUrl(port: number): string {
    return `http://127.0.0.1:${port}`
}

export async function findFreePort(startPort: number, attempts = 20): Promise<number> {
    for (let port = startPort; port < startPort + attempts; port++) {
        const free = await new Promise<boolean>(resolvePromise => {
            const probe = createServer()
            probe.once('error', () => resolvePromise(false))
            probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)))
        })
        if (free) return port
    }
    throw new Error(`No free loopback port in ${startPort}..${startPort + attempts - 1}`)
}

export interface SidecarOptions {
    config: DesktopConfig
    healthUrl: string
    bootTimeoutMs?: number
    maxRestarts?: number
    onState: (state: EngineState, detail?: string) => void
    onLog: (line: string) => void
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export class EngineSidecar {
    private child: ChildProcess | null = null
    private state: EngineState = 'stopped'
    private stopping = false
    private restarts = 0
    private restartTimer: NodeJS.Timeout | null = null
    private healthTimer: NodeJS.Timeout | null = null
    private readonly launch: EngineLaunch

    constructor(private readonly options: SidecarOptions) {
        this.launch = resolveEngineLaunch(options.config)
    }

    get currentState(): EngineState {
        return this.state
    }

    get port(): number {
        return this.options.config.enginePort
    }

    async start(): Promise<void> {
        this.stopping = false
        this.spawn()
    }

    private setState(state: EngineState, detail?: string): void {
        this.state = state
        this.options.onState(state, detail)
    }

    private spawn(): void {
        const { command, args, cwd, env } = this.launch
        this.setState(this.restarts > 0 ? 'restarting' : 'starting')
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        this.child = child

        const forward = (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split('\n')) {
                if (line.trim().length > 0) this.options.onLog(`[engine] ${line}`)
            }
        }
        child.stdout?.on('data', forward)
        child.stderr?.on('data', forward)

        child.on('error', err => {
            this.options.onLog(`[engine] spawn error: ${err.message}`)
            this.scheduleRestart(`spawn failed: ${err.message}`)
        })
        child.on('exit', (code, signal) => {
            this.child = null
            this.clearHealthTimer()
            if (this.stopping) {
                this.setState('stopped')
                return
            }
            this.scheduleRestart(`exited code=${code ?? 'null'} signal=${signal ?? 'null'}`)
        })

        this.waitForHealth()
    }

    private waitForHealth(): void {
        const deadline = Date.now() + (this.options.bootTimeoutMs ?? 90_000)
        const tick = async () => {
            if (this.stopping || !this.child) return
            try {
                const res = await fetch(this.options.healthUrl, { signal: AbortSignal.timeout(2_000) })
                if (res.ok) {
                    this.restarts = 0
                    this.setState('ready')
                    this.options.onLog(`[engine] healthy at ${this.options.healthUrl}`)
                    return
                }
            } catch {
                // not up yet
            }
            if (Date.now() >= deadline) {
                this.options.onLog('[engine] boot timed out waiting for /health')
                this.scheduleRestart('health check timed out')
                return
            }
            this.healthTimer = setTimeout(() => void tick(), 1_000)
        }
        this.healthTimer = setTimeout(() => void tick(), 500)
    }

    private scheduleRestart(reason: string): void {
        this.clearHealthTimer()
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = null
        }
        const maxRestarts = this.options.maxRestarts ?? 5
        if (this.stopping || this.restarts >= maxRestarts) {
            this.setState('failed', reason)
            this.options.onLog(`[engine] giving up after ${this.restarts} restarts: ${reason}`)
            return
        }
        const delay = BACKOFF_MS[Math.min(this.restarts, BACKOFF_MS.length - 1)]
        this.restarts += 1
        this.setState('restarting', `${reason}; retry ${this.restarts} in ${delay}ms`)
        this.options.onLog(`[engine] ${reason}; restarting in ${delay}ms`)
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null
            if (!this.stopping) this.spawn()
        }, delay)
    }

    private clearHealthTimer(): void {
        if (this.healthTimer) {
            clearTimeout(this.healthTimer)
            this.healthTimer = null
        }
    }

    async stop(): Promise<void> {
        this.stopping = true
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = null
        }
        this.clearHealthTimer()
        const child = this.child
        this.child = null
        if (!child) {
            this.setState('stopped')
            return
        }
        await new Promise<void>(resolvePromise => {
            const killTimer = setTimeout(() => {
                child.kill('SIGKILL')
                resolvePromise()
            }, 5_000)
            child.once('exit', () => {
                clearTimeout(killTimer)
                resolvePromise()
            })
            child.kill('SIGTERM')
        })
        this.setState('stopped')
    }
}
