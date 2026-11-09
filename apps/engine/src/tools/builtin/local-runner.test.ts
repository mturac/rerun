import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-runner-tool-'))
process.env.RERUN_API_KEY = ''

type Responder = (_url: string, _init: RequestInit) => Response | Promise<Response>

const state = vi.hoisted(() => ({
    calls: [] as { url: string; init: RequestInit }[],
    responder: ((_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ status: 'completed', stdout: 'done', exitCode: 0 }), { status: 200 })) as Responder,
}))

vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit) => {
        state.calls.push({ url: String(url), init })
        return state.responder(String(url), init)
    }),
)

const { beforeEach, describe, expect, it } = await import('vitest')
const { announceRunner, issueRunnerCredential } = await import('../../local-runner/credentials.js')
const { dataDir } = await import('../../config/paths.js')
const { localRunnerTools } = await import('./local-runner.js')

function register(name: string, url: string, serveToken: string): string {
    const { credential } = issueRunnerCredential(dataDir(), name)
    announceRunner(dataDir(), credential.id, { url, token: serveToken })
    return credential.id
}

type AnyTool = {
    inputSchema: { parse: (v: unknown) => unknown }
    execute: (input: unknown, opts: unknown) => Promise<string>
}

function toolNamed(name: string): AnyTool {
    return localRunnerTools({ agent: { id: 'runner-agent', env: {} } } as never)[name] as never as AnyTool
}

async function run(input: unknown): Promise<string> {
    const tool = toolNamed('runner_task')
    return tool.execute(tool.inputSchema.parse(input), { toolCallId: 'c', messages: [] })
}

async function runNamed(name: string, input: unknown): Promise<string> {
    const tool = toolNamed(name)
    return tool.execute(tool.inputSchema.parse(input), { toolCallId: 'c', messages: [] })
}

const shellTask = { task: { kind: 'shell', command: 'ls -la' } }

beforeEach(() => {
    state.calls.length = 0
    state.responder = () => new Response(JSON.stringify({ status: 'completed', stdout: 'done', exitCode: 0 }), { status: 200 })
})

describe('runner_task', () => {
    it('says so when no runner is registered', async () => {
        expect(await run(shellTask)).toContain('No local runner is registered')
        expect(state.calls).toHaveLength(0)
    })

    it('posts the task to the announced runner with its serving token', async () => {
        register('mac', 'http://127.0.0.1:4700', 'rlrs_token_one')
        const out = await run(shellTask)
        expect(out).toContain('status: completed')
        expect(out).toContain('done')
        expect(state.calls).toHaveLength(1)
        const call = state.calls[0]
        expect(call.url).toBe('http://127.0.0.1:4700/tasks')
        expect(call.init.method).toBe('POST')
        expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer rlrs_token_one')
        expect(JSON.parse(String(call.init.body))).toMatchObject({ kind: 'shell', command: 'ls -la' })
    })

    it('picks the named runner when several are registered', async () => {
        register('first', 'http://127.0.0.1:4701', 'rlrs_first')
        register('second', 'http://127.0.0.1:4702', 'rlrs_second')
        expect(await run({ ...shellTask, runner: 'second' })).toContain('status: completed')
        expect(state.calls[0].url).toBe('http://127.0.0.1:4702/tasks')
        expect(await run({ ...shellTask, runner: 'nope' })).toContain('No local runner matches')
        expect(state.calls).toHaveLength(1)
    })

    it('defaults to the most recently announced runner', async () => {
        vi.useFakeTimers()
        try {
            const base = Date.now()
            vi.setSystemTime(base + 1_000)
            register('older', 'http://127.0.0.1:4801', 'rlrs_older')
            vi.setSystemTime(base + 2_000)
            register('newer', 'http://127.0.0.1:4802', 'rlrs_newer')
            await run(shellTask)
            expect(state.calls[0].url).toBe('http://127.0.0.1:4802/tasks')
        } finally {
            vi.useRealTimers()
        }
    })

    it('returns the pending approval to the agent instead of running', async () => {
        register('ask-runner', 'http://127.0.0.1:4900', 'rlrs_ask')
        state.responder = () =>
            new Response(
                JSON.stringify({ status: 'pending', pendingId: 'p1', approvalText: 'Run shell command: rm -rf x', taskKey: 'k' }),
                { status: 200 },
            )
        const out = await run({ ...shellTask, runner: 'ask-runner' })
        expect(out).toContain('approval')
        expect(out).toContain('p1')
    })

    it('surfaces a runner denial and an http failure as tool text', async () => {
        register('deny-runner', 'http://127.0.0.1:4901', 'rlrs_deny')
        state.responder = () => new Response(JSON.stringify({ status: 'denied', reason: 'mode-never', taskKey: 'k' }), { status: 200 })
        expect(await run({ ...shellTask, runner: 'deny-runner' })).toContain('denied')

        state.responder = () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
        expect(await run({ ...shellTask, runner: 'deny-runner' })).toContain('runner_task failed (500)')
    })

    it('turns a fetch failure into a tool error string', async () => {
        register('down-runner', 'http://127.0.0.1:4902', 'rlrs_down')
        vi.mocked(fetch).mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        expect(await run({ ...shellTask, runner: 'down-runner' })).toContain('runner_task failed: connect ECONNREFUSED')
    })
})

describe('runner_approvals', () => {
    it('says so when the named runner is unknown or nothing is pending', async () => {
        expect(await runNamed('runner_approvals', { runner: 'ghost' })).toContain('No local runner matches')
        register('idle-runner', 'http://127.0.0.1:4910', 'rlrs_idle')
        state.responder = () => new Response(JSON.stringify({ approvals: [] }), { status: 200 })
        expect(await runNamed('runner_approvals', {})).toContain('No local runner has tasks waiting')
    })

    it('lists pendings from each runner with the runner name attached', async () => {
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4910')
                ? new Response(
                      JSON.stringify({
                          approvals: [
                              { id: 'p1', approvalText: 'Run shell command: rm -rf x', taskKey: 'k', action: 'shell:rm -rf x', expiresAt: 'soon' },
                          ],
                      }),
                      { status: 200 },
                  )
                : new Response(JSON.stringify({ approvals: [] }), { status: 200 })
        const out = await runNamed('runner_approvals', { runner: 'idle-runner' })
        expect(out).toContain('p1')
        expect(out).toContain('idle-runner')
        expect(out).toContain('rm -rf x')
        const call = state.calls.find(entry => entry.url === 'http://127.0.0.1:4910/approvals')!
        expect(call.init.method ?? 'GET').toBe('GET')
        expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer rlrs_idle')
    })

    it('reports a runner that cannot be reached instead of failing the list', async () => {
        register('flaky-runner', 'http://127.0.0.1:4911', 'rlrs_flaky')
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4911')
                ? Promise.reject(new Error('connect ECONNREFUSED'))
                : new Response(JSON.stringify({ approvals: [] }), { status: 200 })
        const out = await runNamed('runner_approvals', {})
        expect(out).toContain('Could not reach')
        expect(out).toContain('flaky-runner')
    })
})

describe('runner_approve', () => {
    it('posts the decision to the named runner and shows the outcome', async () => {
        register('decide-runner', 'http://127.0.0.1:4920', 'rlrs_decide')
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4920')
                ? new Response(JSON.stringify({ taskKey: 'k', status: 'completed', stdout: 'ran it', exitCode: 0 }), { status: 200 })
                : new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        const out = await runNamed('runner_approve', { runner: 'decide-runner', approvalId: 'p7', decision: 'approve', scope: 'always' })
        expect(out).toContain('Approved')
        expect(out).toContain('ran it')
        const call = state.calls.find(entry => entry.url === 'http://127.0.0.1:4920/approvals/p7')!
        expect(JSON.parse(String(call.init.body))).toEqual({ decision: 'approve', scope: 'always' })
        expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer rlrs_decide')
    })

    it('denies without a scope and surfaces runner errors as tool text', async () => {
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4920')
                ? new Response(JSON.stringify({ status: 'denied', reason: 'denied-before', taskKey: 'k' }), { status: 200 })
                : new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        const out = await runNamed('runner_approve', { approvalId: 'p8', decision: 'deny' })
        expect(out).toContain('Denied')
        expect(out).toContain('denied-before')
        const call = state.calls.find(entry => entry.url.endsWith('/approvals/p8'))!
        expect(JSON.parse(String(call.init.body))).toEqual({ decision: 'deny' })

        state.responder = () => new Response(JSON.stringify({ error: 'Approval expired' }), { status: 410 })
        expect(await runNamed('runner_approve', { runner: 'decide-runner', approvalId: 'old', decision: 'approve' })).toContain('410')

        state.responder = () => new Response(JSON.stringify({ approvals: [] }), { status: 200 })
        expect(await runNamed('runner_approve', { runner: 'ghost', approvalId: 'p', decision: 'approve' })).toContain('No local runner matches')
    })
})
