import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cursorProvider } from '../../external-agents/cursor.js'
import { codexProvider } from '../../external-agents/codex.js'
import { configuredProviders, externalAgentProviders } from '../../external-agents/index.js'
import { externalAgentTools } from './external-agents.js'

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

describe('cursorProvider', () => {
    it('launches an agent with Basic auth and maps the response', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            calls.push({ url: String(url), init })
            return jsonResponse({ id: 'bc_1', name: 'Fix bug', status: 'RUNNING', target: { branchName: 'cursor/fix-1', url: 'https://cursor.com/agents?id=bc_1', prUrl: 'https://github.com/o/r/pull/1' } })
        }) as unknown as typeof fetch

        const provider = cursorProvider('key-123', fetchImpl)
        const task = await provider.launch({ prompt: 'fix it', repository: 'https://github.com/o/r', ref: 'main', branchName: 'cursor/fix-1', autoCreatePr: true })

        expect(calls[0].url).toBe('https://api.cursor.com/v0/agents')
        expect(calls[0].init.method).toBe('POST')
        expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('key-123:').toString('base64')}`)
        const body = JSON.parse(String(calls[0].init.body))
        expect(body.prompt).toBe('fix it')
        expect(body.source).toEqual({ repository: 'https://github.com/o/r', ref: 'main' })
        expect(body.target).toEqual({ branchName: 'cursor/fix-1', autoCreatePr: true })
        expect(task).toMatchObject({ provider: 'cursor', id: 'bc_1', status: 'running', prUrl: 'https://github.com/o/r/pull/1', branch: 'cursor/fix-1' })
    })

    it('maps FINISHED to completed and ERROR to failed', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ id: 'a', status: 'FINISHED', summary: 'done' }))
            .mockResolvedValueOnce(jsonResponse({ id: 'b', status: 'ERROR' })) as unknown as typeof fetch
        const provider = cursorProvider('k', fetchImpl)
        expect((await provider.status('a')).status).toBe('completed')
        expect((await provider.status('b')).status).toBe('failed')
    })

    it('throws with status detail on API errors', async () => {
        const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
        const provider = cursorProvider('bad', fetchImpl)
        await expect(provider.status('x')).rejects.toThrow('Cursor API GET /v0/agents/x failed: 401')
    })

    it('supports followup, stop and list', async () => {
        const paths: string[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            paths.push(`${init.method} ${new URL(String(url)).pathname}`)
            if (String(url).includes('/followup')) return jsonResponse({ id: 'a', status: 'RUNNING' })
            if (String(url).includes('/agents?')) return jsonResponse({ agents: [{ id: 'a', status: 'FINISHED' }] })
            return jsonResponse({})
        }) as unknown as typeof fetch
        const provider = cursorProvider('k', fetchImpl)
        await provider.followup!('a', 'more')
        await provider.stop!('a')
        const list = await provider.list!()
        expect(paths).toEqual(['POST /v0/agents/a/followup', 'POST /v0/agents/a/stop', 'GET /v0/agents'])
        expect(list).toHaveLength(1)
    })
})

function fakeJwt(expSeconds?: number): string {
    const payload = Buffer.from(JSON.stringify(expSeconds ? { exp: expSeconds } : {})).toString('base64url')
    return `h.${payload}.s`
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600

function cloudTask(overrides: Record<string, unknown> = {}) {
    return {
        id: 'task_e_123',
        title: 'Do the thing',
        task_status_display: {
            latest_turn_status_display: {
                turn_id: 'task_e_123~assttrn_1',
                turn_status: 'completed',
                diff_stats: { files_modified: 2, lines_added: 10, lines_removed: 3 },
            },
            environment_label: 'owner/repo',
            branch_name: 'main',
        },
        pull_requests: [{ pull_request: { url: 'https://github.com/o/r/pull/7', state: 'open' } }],
        ...overrides,
    }
}

describe('codexProvider (Codex Cloud)', () => {
    const envCreds = { CODEX_OAUTH_TOKEN: fakeJwt(FUTURE_EXP), CODEX_OAUTH_ACCOUNT_ID: 'acct-1' }

    function providerWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
        return codexProvider({ agentEnv: envCreds, env: {} as NodeJS.ProcessEnv, fetchImpl, ...extra } as any)
    }

    it('isConfigured is false without credentials and true with env credentials', () => {
        expect(codexProvider({ agentEnv: {}, env: {} as NodeJS.ProcessEnv, authPath: '/nonexistent/auth.json' }).isConfigured()).toBe(false)
        expect(providerWith(vi.fn() as any).isConfigured()).toBe(true)
    })

    it('isConfigured is false when the token JWT is expired', () => {
        const expired = { CODEX_OAUTH_TOKEN: fakeJwt(Math.floor(Date.now() / 1000) - 60), CODEX_OAUTH_ACCOUNT_ID: 'a' }
        const provider = codexProvider({ agentEnv: expired, env: {} as NodeJS.ProcessEnv, authPath: '/nonexistent' })
        expect(provider.isConfigured()).toBe(false)
    })

    it('reads credentials from auth.json when env credentials are absent', async () => {
        const authPath = join(mkdtempSync(join(tmpdir(), 'codex-auth-')), 'auth.json')
        writeFileSync(authPath, JSON.stringify({ tokens: { access_token: fakeJwt(FUTURE_EXP), account_id: 'acct-file' } }))
        const seen: any[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            seen.push(init.headers)
            return jsonResponse({ items: [] })
        }) as unknown as typeof fetch
        const provider = codexProvider({ agentEnv: {}, env: {} as NodeJS.ProcessEnv, fetchImpl, authPath })
        expect(provider.isConfigured()).toBe(true)
        await provider.list!()
        expect(seen[0].authorization).toBe(`Bearer ${fakeJwt(FUTURE_EXP)}`)
        expect(seen[0]['chatgpt-account-id']).toBe('acct-file')
    })

    it('list maps cloud task items to normalized tasks', async () => {
        const calls: string[] = []
        const fetchImpl = vi.fn(async (url: any) => {
            calls.push(String(url))
            return jsonResponse({ items: [cloudTask(), cloudTask({ id: 'task_e_456', title: 'Other', task_status_display: { latest_turn_status_display: { turn_status: 'in_progress' } } })], cursor: null })
        }) as unknown as typeof fetch
        const tasks = await providerWith(fetchImpl).list!()
        expect(calls[0]).toBe('https://chatgpt.com/backend-api/codex/tasks/list?limit=20')
        expect(tasks).toHaveLength(2)
        expect(tasks[0]).toMatchObject({
            provider: 'codex',
            id: 'task_e_123',
            name: 'Do the thing',
            status: 'completed',
            url: 'https://chatgpt.com/codex/tasks/task_e_123',
            prUrl: 'https://github.com/o/r/pull/7',
            branch: 'main',
            summary: '+10/-3 • 2 files',
        })
        expect(tasks[1].status).toBe('running')
    })

    it('status fetches task details and maps turn status', async () => {
        const fetchImpl = vi.fn(async (url: any) => {
            expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/tasks/task_e_123')
            return jsonResponse({ task: cloudTask({ task_status_display: { latest_turn_status_display: { turn_status: 'failed' } } }) })
        }) as unknown as typeof fetch
        const task = await providerWith(fetchImpl).status('task_e_123')
        expect(task.status).toBe('failed')
    })

    it('launch resolves the environment and posts a new_task payload', async () => {
        const bodies: any[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            const u = String(url)
            if (u.endsWith('/environments')) {
                return jsonResponse([{ id: 'env-1', label: 'owner/repo', repo_map: { r: { name: 'owner/repo' } } }])
            }
            bodies.push(JSON.parse(String(init.body)))
            return jsonResponse({ task: { id: 'task_e_new', title: 't', task_status_display: { latest_turn_status_display: { turn_status: 'pending' } } } })
        }) as unknown as typeof fetch
        const provider = codexProvider({
            agentEnv: { ...envCreds, RERUN_CODEX_CLOUD_ENV_ID: 'env-1' },
            env: {} as NodeJS.ProcessEnv,
            fetchImpl,
        })
        const task = await provider.launch({ prompt: 'fix it', repository: 'https://github.com/owner/repo', branchName: 'feature/x' })
        expect(bodies[0]).toEqual({
            input_items: [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: 'fix it' }] }],
            new_task: { environment_id: 'env-1', branch: 'feature/x' },
        })
        expect(task.id).toBe('task_e_new')
        expect(task.status).toBe('running')
    })

    it('launch matches the environment by repository when no override is set', async () => {
        const bodies: any[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            if (String(url).endsWith('/environments')) {
                return jsonResponse([
                    { id: 'env-a', label: 'other/proj' },
                    { id: 'env-b', label: 'mturac/RightStack' },
                ])
            }
            bodies.push(JSON.parse(String(init.body)))
            return jsonResponse({ task: { id: 'task_e_new' } })
        }) as unknown as typeof fetch
        const provider = codexProvider({ agentEnv: envCreds, env: {} as NodeJS.ProcessEnv, fetchImpl })
        await provider.launch({ prompt: 'x', repository: 'https://github.com/mturac/RightStack.git' })
        expect(bodies[0].new_task.environment_id).toBe('env-b')
        expect(bodies[0].new_task.branch).toBe('main')
    })

    it('followup posts a follow_up payload with the task current turn', async () => {
        const bodies: any[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            const u = String(url)
            if (u.endsWith('/tasks/task_e_123') && (!init.method || init.method === 'GET')) {
                return jsonResponse({ task: { id: 'task_e_123', current_turn_id: 'task_e_123~assttrn_9' } })
            }
            bodies.push(JSON.parse(String(init.body)))
            return jsonResponse({ task: cloudTask() })
        }) as unknown as typeof fetch
        await providerWith(fetchImpl).followup!('task_e_123', 'please adjust')
        expect(bodies[0].follow_up).toEqual({ task_id: 'task_e_123', turn_id: 'task_e_123~assttrn_9' })
        expect(bodies[0].input_items[0].content[0].text).toBe('please adjust')
    })

    it('stop posts to the task cancel endpoint', async () => {
        const paths: string[] = []
        const fetchImpl = vi.fn(async (url: any, init: any) => {
            paths.push(`${init.method} ${new URL(String(url)).pathname}`)
            return jsonResponse({ success: true })
        }) as unknown as typeof fetch
        await providerWith(fetchImpl).stop!('task_e_123')
        expect(paths).toEqual(['POST /backend-api/codex/tasks/task_e_123/cancel'])
    })

    it('surfaces API errors without leaking the token', async () => {
        const fetchImpl = vi.fn(async () => new Response('expired', { status: 401 })) as unknown as typeof fetch
        await expect(providerWith(fetchImpl).status('task_e_1')).rejects.toThrow('Codex Cloud API GET /tasks/task_e_1 failed: 401')
    })
})

describe('provider resolution', () => {
    function stubCliPathsMissing() {
        vi.stubEnv('RERUN_CODEX_CLI_PATH', '/nonexistent/codex')
        vi.stubEnv('RERUN_CLAUDE_CLI_PATH', '/nonexistent/claude')
    }

    it('reads CURSOR_API_KEY from agent env before process env', () => {
        stubCliPathsMissing()
        vi.stubEnv('CURSOR_API_KEY', 'process-key')
        vi.stubEnv('CODEX_HOME', '/nonexistent-codex-home')
        const providers = externalAgentProviders('agent-1', { CURSOR_API_KEY: 'agent-key' })
        expect(providers[0].isConfigured()).toBe(true)
        expect(configuredProviders('agent-1', {}).length).toBe(1)
        expect(configuredProviders('agent-1', {}).length).toBe(1)
    })

    it('reports unconfigured when no key exists anywhere', () => {
        const emptyEnv = {
            CURSOR_API_KEY: '',
            CODEX_OAUTH_TOKEN: '',
            CODEX_OAUTH_ACCOUNT_ID: '',
            CODEX_HOME: '/nonexistent-codex-home',
            RERUN_CODEX_CLI_PATH: '/nonexistent/codex',
            RERUN_CLAUDE_CLI_PATH: '/nonexistent/claude',
        } as unknown as NodeJS.ProcessEnv
        expect(configuredProviders('agent-1', {}, emptyEnv).length).toBe(0)
    })
})

describe('externalAgentTools', () => {
    function ctx(env: Record<string, string> = {}) {
        return { agent: { id: 'agent-1', env, config: { tools: { externalAgents: true } } } } as any
    }
    function call(tools: any, name: string, args: Record<string, unknown>) {
        const t = tools[name] as any
        return t.execute(t.inputSchema.parse(args), { toolCallId: 'c', messages: [] })
    }

    it('returns a clear error when no provider is configured', async () => {
        vi.stubEnv('CURSOR_API_KEY', '')
        vi.stubEnv('CODEX_HOME', '/nonexistent-codex-home')
        vi.stubEnv('RERUN_CODEX_CLI_PATH', '/nonexistent/codex')
        vi.stubEnv('RERUN_CLAUDE_CLI_PATH', '/nonexistent/claude')
        const tools = externalAgentTools(ctx())
        const result = await call(tools, 'external_agent_start', { prompt: 'x' })
        expect(result.error).toContain('CURSOR_API_KEY')
    })

    it('launches through the cursor provider using global fetch', async () => {
        vi.stubEnv('CURSOR_API_KEY', '')
        vi.stubEnv('CODEX_HOME', '/nonexistent-codex-home')
        const fetchMock = vi.fn(async () => jsonResponse({ id: 'bc_9', status: 'RUNNING' }))
        vi.stubGlobal('fetch', fetchMock)
        const tools = externalAgentTools(ctx({ CURSOR_API_KEY: 'agent-key' }))
        const result = await call(tools, 'external_agent_start', { prompt: 'do thing', repository: 'https://github.com/o/r' })
        expect(result.ok).toBe(true)
        expect(result.task.id).toBe('bc_9')
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('polls status and stops tasks', async () => {
        vi.stubEnv('CURSOR_API_KEY', '')
        vi.stubEnv('CODEX_HOME', '/nonexistent-codex-home')
        const fetchMock = vi.fn(async (url: any) => {
            const path = new URL(String(url)).pathname
            if (path.endsWith('/stop')) return jsonResponse({})
            return jsonResponse({ id: 'bc_9', status: 'FINISHED', summary: 'shipped', target: { prUrl: 'https://github.com/o/r/pull/2' } })
        })
        vi.stubGlobal('fetch', fetchMock)
        const tools = externalAgentTools(ctx({ CURSOR_API_KEY: 'k' }))
        const status = await call(tools, 'external_agent_status', { id: 'bc_9' })
        expect(status.task.status).toBe('completed')
        expect(status.task.prUrl).toBe('https://github.com/o/r/pull/2')
        const stop = await call(tools, 'external_agent_stop', { id: 'bc_9' })
        expect(stop.ok).toBe(true)
    })
})
