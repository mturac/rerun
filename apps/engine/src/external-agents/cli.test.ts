import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentDir } from '../config/paths.js'
import { claudeCliProvider, cliProvider, codexCliProvider, cursorCliProvider } from './cli.js'
import { configuredProviders, externalAgentProviders } from './index.js'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-cli-agents-'))

function fakeSpawn(calls: any[]) {
    return vi.fn((cmd: string, args: string[], opts: any) => {
        calls.push({ cmd, args, opts })
        return { pid: 4321, unref: vi.fn() }
    }) as any
}

function runDirOf(id: string) {
    return resolve(agentDir('test-agent'), 'external-runs', id)
}

function baseOpts(overrides: Record<string, unknown> = {}) {
    return {
        name: 'fake-cli',
        agentId: 'test-agent',
        agentEnv: {},
        env: {} as NodeJS.ProcessEnv,
        command: () => ({ cmd: '/bin/echo', args: ['hello'] }),
        buildArgs: (input: any) => ['--task', input.prompt],
        ...overrides,
    }
}

describe('cliProvider', () => {
    it('launch creates the run dir, writes run.json and spawns the detached wrapper', async () => {
        const calls: any[] = []
        const provider = cliProvider(baseOpts({
            agentEnv: { DELEGATE_FLAG: 'on' },
            spawnImpl: fakeSpawn(calls),
        }) as any)

        const task = await provider.launch({ prompt: 'fix the bug' })

        expect(task.status).toBe('running')
        expect(task.provider).toBe('fake-cli')
        const dir = runDirOf(task.id)
        expect(existsSync(join(dir, 'run.json'))).toBe(true)
        const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
        expect(run).toMatchObject({ provider: 'fake-cli', id: task.id, pid: 4321, status: 'running', cwd: dir })
        expect(run.logPath).toBe(join(dir, 'output.log'))
        expect(run.exitPath).toBe(join(dir, 'exit.txt'))

        expect(calls).toHaveLength(1)
        const call = calls[0]
        expect(call.cmd).toBe('sh')
        expect(call.args[0]).toBe('-c')
        expect(call.args[1]).toBe('"$@" >"$RERUN_LOG" 2>&1; echo $? >"$RERUN_EXIT"')
        expect(call.args.slice(2)).toEqual(['sh', '/bin/echo', 'hello', '--task', expect.stringContaining('fix the bug')])
        expect(call.args.at(-1)).toContain('fix the bug')
        expect(call.opts.detached).toBe(true)
        expect(call.opts.cwd).toBe(dir)
        expect(call.opts.env.DELEGATE_FLAG).toBe('on')
        expect(call.opts.env.FOO_UNSET).toBeUndefined()
        expect(call.opts.env.RERUN_LOG).toBe(join(dir, 'output.log'))
        expect(call.opts.env.RERUN_EXIT).toBe(join(dir, 'exit.txt'))
    })

    it('status is running while the pid is alive and no exit file exists', async () => {
        const provider = cliProvider(baseOpts({ spawnImpl: fakeSpawn([]), pidAlive: () => true }) as any)
        const task = await provider.launch({ prompt: 'x' })
        expect((await provider.status(task.id)).status).toBe('running')
    })

    it('status is completed on exit code 0 and failed with the log tail on nonzero', async () => {
        const provider = cliProvider(baseOpts({ spawnImpl: fakeSpawn([]), pidAlive: () => true }) as any)
        const ok = await provider.launch({ prompt: 'ok' })
        writeFileSync(join(runDirOf(ok.id), 'exit.txt'), '0\n')
        writeFileSync(join(runDirOf(ok.id), 'output.log'), 'all done')
        const done = await provider.status(ok.id)
        expect(done.status).toBe('completed')
        expect(done.summary).toBe('all done')

        const bad = await provider.launch({ prompt: 'bad' })
        writeFileSync(join(runDirOf(bad.id), 'exit.txt'), '2\n')
        writeFileSync(join(runDirOf(bad.id), 'output.log'), `${'x'.repeat(600)}boom`)
        const failed = await provider.status(bad.id)
        expect(failed.status).toBe('failed')
        expect(failed.error).toContain('code 2')
        expect(failed.summary).toContain('boom')
        expect((failed.summary as string).length).toBeLessThanOrEqual(500)
    })

    it('status parses JSONL output into events and prefers event text for the summary', async () => {
        const provider = cliProvider(baseOpts({ spawnImpl: fakeSpawn([]), pidAlive: () => true }) as any)
        const task = await provider.launch({ prompt: 'x' })
        writeFileSync(join(runDirOf(task.id), 'exit.txt'), '0\n')
        writeFileSync(join(runDirOf(task.id), 'output.log'), [
            '{"type":"system","subtype":"init"}',
            'not json at all',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"final answer"}]}}',
        ].join('\n'))
        const status = await provider.status(task.id)
        expect(status.status).toBe('completed')
        expect(status.summary).toBe('final answer')
        expect(status.events).toHaveLength(3)
    })

    it('status is failed when the pid is dead and no exit file was written', async () => {
        const provider = cliProvider(baseOpts({ spawnImpl: fakeSpawn([]), pidAlive: () => false }) as any)
        const task = await provider.launch({ prompt: 'x' })
        const status = await provider.status(task.id)
        expect(status.status).toBe('failed')
        expect(status.error).toContain('engine may have restarted')
    })

    it('stop kills the process group and survives ESRCH', async () => {
        const kill = vi.fn(() => {
            const error = new Error('no such process') as NodeJS.ErrnoException
            error.code = 'ESRCH'
            throw error
        })
        const provider = cliProvider(baseOpts({ spawnImpl: fakeSpawn([]), killImpl: kill }) as any)
        const task = await provider.launch({ prompt: 'x' })
        await provider.stop(task.id)
        expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM')

        const real = vi.fn()
        const provider2 = cliProvider(baseOpts({ spawnImpl: fakeSpawn([]), killImpl: real }) as any)
        const task2 = await provider2.launch({ prompt: 'y' })
        await provider2.stop(task2.id)
        expect(real).toHaveBeenCalledWith(-4321, 'SIGTERM')
    })

    it('isConfigured is false when the binary does not exist', () => {
        const missing = cliProvider(baseOpts({ command: () => ({ cmd: '/nonexistent/cli', args: [] }) }) as any)
        expect(missing.isConfigured()).toBe(false)
        const present = cliProvider(baseOpts({ command: () => ({ cmd: process.execPath, args: [] }) }) as any)
        expect(present.isConfigured()).toBe(true)
    })

    it('appends extra args from the configured env key', async () => {
        const calls: any[] = []
        const provider = cliProvider(baseOpts({
            extraEnvArgs: 'RERUN_FAKE_ARGS',
            agentEnv: { RERUN_FAKE_ARGS: '--flag value' },
            spawnImpl: fakeSpawn(calls),
        }) as any)
        await provider.launch({ prompt: 'x' })
        expect(calls[0].args.slice(-2)).toEqual(['--flag', 'value'])
    })
})

describe('codexCliProvider and claudeCliProvider', () => {
    it('codex exec gets -m before the prompt and extra args appended', async () => {
        const calls: any[] = []
        const provider = codexCliProvider('test-agent', { RERUN_CODEX_CLI_PATH: '/bin/echo', RERUN_CODEX_CLI_ARGS: '--sandbox read-only' }, {}, { spawnImpl: fakeSpawn(calls) })
        const task = await provider.launch({ prompt: 'ship it', model: 'gpt-test' })
        const argv = calls[0].args.slice(4)
        expect(argv.slice(0, 8)).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"', '-m'])
        expect(argv[8]).toBe('gpt-test')
        expect(argv.at(-2)).toBe('--sandbox')
        expect(argv.slice(-2)).toEqual(['--sandbox', 'read-only'])
        expect(task.provider).toBe('codex-cli')
        expect(provider.followup).toBeUndefined()
        expect(provider.list).toBeUndefined()
    })

    it('claude -p gets stream-json output and --model when set', async () => {
        const calls: any[] = []
        const provider = claudeCliProvider('test-agent', { RERUN_CLAUDE_CLI_PATH: '/bin/echo', RERUN_CLAUDE_MODEL: 'claude-test' }, {}, { spawnImpl: fakeSpawn(calls) })
        await provider.launch({ prompt: 'review this' })
        const argv = calls[0].args.slice(4)
        expect(argv[0]).toBe('-p')
        expect(argv).toContain('--output-format')
        expect(argv).toContain('stream-json')
        expect(argv).toContain('--verbose')
        expect(argv).toContain('--model')
        expect(argv).toContain('claude-test')
        expect(argv.join(' ')).not.toContain('--dangerously')
    })

    it('cursor-agent gets -p --force --trust and the prompt last', async () => {
        const calls: any[] = []
        const provider = cursorCliProvider('test-agent', { RERUN_CURSOR_CLI_PATH: '/bin/echo', RERUN_CURSOR_MODEL: 'auto' }, {}, { spawnImpl: fakeSpawn(calls) })
        const task = await provider.launch({ prompt: 'fix the bug' })
        const argv = calls[0].args.slice(4)
        expect(argv.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--force', '--trust'])
        expect(argv).toContain('--model')
        expect(argv.at(-1)).toContain('fix the bug')
        expect(task.provider).toBe('cursor-cli')
    })
})

describe('cli provider resolution', () => {
    it('includes cli providers only when their binary resolves', () => {
        const env = { CODEX_HOME: '/nonexistent-codex-home' }
        const agentEnv = {
            RERUN_CODEX_CLI_PATH: '/bin/echo',
            RERUN_CLAUDE_CLI_PATH: '/nonexistent/claude',
            RERUN_CURSOR_CLI_PATH: '/bin/echo',
        }
        const names = externalAgentProviders('test-agent', agentEnv, env).map(p => p.name)
        expect(names).toEqual(['cursor', 'codex', 'codex-cli', 'claude-cli', 'cursor-cli'])
        const configured = configuredProviders('test-agent', agentEnv, env).map(p => p.name)
        expect(configured).toEqual(['codex-cli', 'cursor-cli'])
    })
})
