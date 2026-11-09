import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { RunnerTask } from './types.js'

export type SpawnImpl = typeof spawn

export type ExecResult = {
    status: 'completed' | 'failed'
    exitCode?: number | null
    stdout?: string
    stderr?: string
    error?: string
    path?: string
    bytes?: number
}

const OUTPUT_LIMIT = 200_000
const DEFAULT_TIMEOUT_MS = 120_000

export function resolveScoped(rootDir: string, rel: string): string | null {
    const root = resolve(rootDir)
    const target = resolve(root, rel)
    if (target !== root && !target.startsWith(root + sep)) return null
    return target
}

function runShell(command: string, cwd: string, spawnImpl: SpawnImpl, timeoutMs: number): Promise<ExecResult> {
    return new Promise(done => {
        let child
        try {
            child = spawnImpl(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
            done({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
            return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (result: ExecResult) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            done(result)
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            finish({ status: 'failed', error: `timed out after ${timeoutMs}ms`, stdout, stderr })
        }, timeoutMs)
        timer.unref?.()
        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
        })
        child.on('error', err => finish({ status: 'failed', error: err.message, stdout, stderr }))
        child.on('close', (code: number | null) =>
            finish({ status: code === 0 ? 'completed' : 'failed', exitCode: code, stdout, stderr }),
        )
    })
}

export async function executeTask(
    task: RunnerTask,
    rootDir: string,
    deps: { spawnImpl?: SpawnImpl; timeoutMs?: number } = {},
): Promise<ExecResult> {
    const spawnImpl = deps.spawnImpl ?? spawn
    if (task.kind === 'shell') {
        const cwd = task.cwd === undefined ? resolve(rootDir) : resolveScoped(rootDir, task.cwd)
        if (cwd === null) return { status: 'failed', error: 'cwd escapes the runner root' }
        return runShell(task.command ?? '', cwd, spawnImpl, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    }
    const target = resolveScoped(rootDir, task.path ?? '')
    if (target === null) return { status: 'failed', error: 'path escapes the runner root', path: task.path }
    if (task.kind === 'file.read') {
        try {
            const content = await readFile(target, 'utf8')
            return { status: 'completed', stdout: content, path: task.path }
        } catch (err) {
            return { status: 'failed', error: err instanceof Error ? err.message : String(err), path: task.path }
        }
    }
    try {
        await mkdir(dirname(target), { recursive: true })
        const content = task.content ?? ''
        await writeFile(target, content, 'utf8')
        return { status: 'completed', bytes: Buffer.byteLength(content, 'utf8'), path: task.path }
    } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err), path: task.path }
    }
}
