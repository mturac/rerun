import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { jwtExpiresAt } from '../connections/codex-auth.js'
import type { ExternalAgentLaunch, ExternalAgentProvider, ExternalAgentStatus, ExternalAgentTask } from './types.js'

// Codex Cloud is the surface `codex cloud` drives: ChatGPT-account tasks on chatgpt.com, not the
// api.openai.com Agents beta (which needs a platform sk- key a ChatGPT login cannot mint). The CLI
// authenticates with the OAuth access token plus the account id, both stored in ~/.codex/auth.json
// by `codex login`; the engine's own Codex connection exposes the same pair as CODEX_OAUTH_TOKEN /
// CODEX_OAUTH_ACCOUNT_ID.
const BASE_URL = 'https://chatgpt.com/backend-api/codex'
const TASK_URL = (id: string) => `https://chatgpt.com/codex/tasks/${id}`

type CloudCredentials = {
    accessToken: string
    accountId: string
    expiresAt?: number
}

type TurnStatusDisplay = {
    turn_id?: string
    turn_status?: string
    diff_stats?: { files_modified?: number | null; lines_added?: number | null; lines_removed?: number | null } | null
    cancellation_requested_at?: number | null
}

type CloudTask = {
    id?: string
    title?: string
    created_at?: number
    updated_at?: number
    current_turn_id?: string
    archived?: boolean
    task_status_display?: {
        latest_turn_status_display?: TurnStatusDisplay | null
        environment_label?: string
        branch_name?: string
    }
    pull_requests?: { pull_request?: { url?: string; state?: string } }[]
    external_pull_requests?: { pull_request?: { url?: string; state?: string } }[]
    environment_id?: string
    [key: string]: unknown
}

type CloudEnvironment = {
    id?: string
    label?: string
    repo_map?: Record<string, { name?: string; full_name?: string; default_branch?: string; owner?: { login?: string } }>
    [key: string]: unknown
}

export type CodexCloudProviderOptions = {
    agentEnv?: Record<string, string>
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    // Test seam: point credential resolution at a specific auth.json instead of $CODEX_HOME or ~/.codex.
    authPath?: string
    now?: () => number
}

function credentialsFromEnv(env: Record<string, string>): CloudCredentials | undefined {
    const accessToken = env.CODEX_OAUTH_TOKEN || ''
    const accountId = env.CODEX_OAUTH_ACCOUNT_ID || ''
    if (!accessToken || !accountId) return undefined
    const expiresAt = Number(env.CODEX_OAUTH_EXPIRES_AT) || jwtExpiresAt(accessToken)
    return { accessToken, accountId, expiresAt }
}

function credentialsFromFile(authPath: string): CloudCredentials | undefined {
    let parsed: { tokens?: { access_token?: string; account_id?: string | null } }
    try {
        parsed = JSON.parse(readFileSync(authPath, 'utf8'))
    } catch {
        return undefined
    }
    const accessToken = parsed.tokens?.access_token
    const accountId = parsed.tokens?.account_id
    if (!accessToken || !accountId) return undefined
    return { accessToken, accountId, expiresAt: jwtExpiresAt(accessToken) }
}

function resolveCredentials(agentEnv: Record<string, string>, env: NodeJS.ProcessEnv, authPath: string): CloudCredentials | undefined {
    return credentialsFromEnv(agentEnv) ?? credentialsFromEnv(env as Record<string, string>) ?? credentialsFromFile(authPath)
}

function defaultAuthPath(env: NodeJS.ProcessEnv): string {
    const codexHome = env.CODEX_HOME || join(homedir(), '.codex')
    return join(codexHome, 'auth.json')
}

function toStatus(raw: string | undefined): ExternalAgentStatus {
    switch ((raw ?? '').toLowerCase()) {
        case 'queued':
            return 'queued'
        case 'in_progress':
        case 'running':
        case 'working':
        case 'pending':
            return 'running'
        case 'completed':
        case 'complete':
        case 'succeeded':
        case 'finished':
            return 'completed'
        case 'failed':
        case 'error':
            return 'failed'
        case 'cancelled':
        case 'canceled':
        case 'stopped':
            return 'stopped'
        default:
            return 'unknown'
    }
}

function pullRequestUrl(task: CloudTask): string | undefined {
    const entries = [...(task.pull_requests ?? []), ...(task.external_pull_requests ?? [])]
    for (const entry of entries) {
        const url = entry?.pull_request?.url
        if (url) return url
    }
    return undefined
}

function diffSummary(stats: TurnStatusDisplay['diff_stats']): string | undefined {
    if (!stats) return undefined
    const files = stats.files_modified
    const added = stats.lines_added
    const removed = stats.lines_removed
    if (files == null && added == null && removed == null) return undefined
    return `+${added ?? 0}/-${removed ?? 0} • ${files ?? 0} files`
}

function toTask(task: CloudTask): ExternalAgentTask {
    const display = task.task_status_display?.latest_turn_status_display
    const status = toStatus(display?.turn_status)
    const summary = diffSummary(display?.diff_stats)
    return {
        provider: 'codex',
        id: task.id ?? '',
        name: task.title ?? task.id ?? '',
        status,
        url: task.id ? TASK_URL(task.id) : undefined,
        prUrl: pullRequestUrl(task),
        summary,
        branch: task.task_status_display?.branch_name,
        raw: task,
    }
}

function userMessageItem(text: string) {
    return {
        type: 'message',
        role: 'user',
        content: [{ content_type: 'text', text }],
    }
}

// repo_map values name the repository the environment was built for; labels are often 'owner/repo'
// but can be arbitrary, so match on both the full 'owner/repo' tail and the bare repo name.
function repoCandidates(repository: string | undefined): string[] {
    if (!repository) return []
    const trimmed = repository.trim().replace(/\.git$/, '').replace(/\/+$/, '')
    const parts = trimmed.split('/')
    const tail = parts.slice(-2).join('/')
    const name = parts.at(-1) ?? ''
    return [...new Set([trimmed.toLowerCase(), tail.toLowerCase(), name.toLowerCase()].filter(Boolean))]
}

function environmentMatches(env: CloudEnvironment, candidates: string[]): boolean {
    if (candidates.length === 0) return false
    const label = (env.label ?? '').toLowerCase()
    if (label && candidates.includes(label)) return true
    for (const repo of Object.values(env.repo_map ?? {})) {
        for (const value of [repo?.name, repo?.full_name]) {
            const v = (value ?? '').toLowerCase()
            if (v && candidates.some(c => v === c || v.endsWith(`/${c}`) || v.endsWith(c))) return true
        }
    }
    return false
}

export function codexProvider(opts: CodexCloudProviderOptions = {}): ExternalAgentProvider {
    const agentEnv = opts.agentEnv ?? {}
    const env = opts.env ?? process.env
    const fetchImpl = opts.fetchImpl ?? fetch
    const authPath = opts.authPath ?? defaultAuthPath(env)
    const now = opts.now ?? Date.now

    function credentials(): CloudCredentials | undefined {
        return resolveCredentials(agentEnv, env, authPath)
    }

    async function call<T>(creds: CloudCredentials, method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetchImpl(`${BASE_URL}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${creds.accessToken}`,
                'chatgpt-account-id': creds.accountId,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new Error(`Codex Cloud API ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`)
        }
        return (await res.json()) as T
    }

    async function requireCredentials(): Promise<CloudCredentials> {
        const creds = credentials()
        if (!creds) throw new Error('Codex Cloud is not configured: no CODEX_OAUTH_TOKEN/CODEX_OAUTH_ACCOUNT_ID and no readable ~/.codex/auth.json')
        return creds
    }

    async function turnError(creds: CloudCredentials, id: string): Promise<string | undefined> {
        const body = await call<{ turn_mapping?: Record<string, { turn?: { error?: { message?: string } } }> }>(creds, 'GET', `/tasks/${encodeURIComponent(id)}/turns`)
        for (const entry of Object.values(body.turn_mapping ?? {})) {
            const message = entry?.turn?.error?.message
            if (message) return message
        }
        return undefined
    }

    async function taskDetails(creds: CloudCredentials, id: string): Promise<CloudTask> {
        const body = await call<{ task?: CloudTask } & CloudTask>(creds, 'GET', `/tasks/${encodeURIComponent(id)}`)
        return body.task ?? body
    }

    async function resolveEnvironment(creds: CloudCredentials, input: ExternalAgentLaunch): Promise<CloudEnvironment> {
        const override = agentEnv.RERUN_CODEX_CLOUD_ENV_ID || env.RERUN_CODEX_CLOUD_ENV_ID || agentEnv.CODEX_CLOUD_ENV_ID || env.CODEX_CLOUD_ENV_ID
        const environments = await call<CloudEnvironment[]>(creds, 'GET', '/environments')
        const usable = environments.filter(e => e.id)
        if (override) {
            const byId = usable.find(e => e.id === override)
            if (byId) return byId
            const byLabel = usable.find(e => (e.label ?? '').toLowerCase() === override.toLowerCase())
            if (byLabel) return byLabel
            throw new Error(`Codex Cloud environment "${override}" not found. Available: ${usable.map(e => e.label ?? e.id).join(', ')}`)
        }
        const candidates = repoCandidates(input.repository)
        const matched = usable.find(e => environmentMatches(e, candidates))
        if (matched) return matched
        if (usable.length === 1) return usable[0]
        const labels = usable.map(e => e.label ?? e.id).join(', ')
        throw new Error(
            candidates.length > 0
                ? `No Codex Cloud environment matches repository "${input.repository}". Available: ${labels}. Set RERUN_CODEX_CLOUD_ENV_ID to pick one explicitly.`
                : `Codex Cloud launch needs an environment. Set RERUN_CODEX_CLOUD_ENV_ID or pass a repository that matches one. Available: ${labels}`,
        )
    }

    function defaultBranch(environment: CloudEnvironment, input: ExternalAgentLaunch): string {
        const explicit = input.branchName || input.ref
        if (explicit) return explicit
        const repos = Object.values(environment.repo_map ?? {})
        const candidates = repoCandidates(input.repository)
        const repo = candidates.length > 0
            ? repos.find(r => repoCandidates(r?.full_name || `${r?.owner?.login ?? ''}/${r?.name ?? ''}`).some(c => candidates.includes(c)))
            : repos[0]
        return repo?.default_branch || 'main'
    }

    return {
        name: 'codex',
        isConfigured: () => {
            const creds = credentials()
            if (!creds) return false
            // An expired ChatGPT access token cannot be refreshed here (that is the connection's
            // job), so the provider steps aside instead of surfacing a 401 on every call.
            return creds.expiresAt === undefined || creds.expiresAt > now()
        },

        async launch(input: ExternalAgentLaunch) {
            const creds = await requireCredentials()
            const environment = await resolveEnvironment(creds, input)
            const body = await call<{ task?: CloudTask } & CloudTask>(creds, 'POST', '/tasks', {
                input_items: [userMessageItem(input.prompt)],
                new_task: {
                    environment_id: environment.id!,
                    branch: defaultBranch(environment, input),
                },
            })
            const task = body.task ?? body
            if (!task.id) throw new Error('Codex Cloud task creation did not return a task id')
            return toTask(task.task_status_display ? task : { ...task, task_status_display: { latest_turn_status_display: { turn_status: 'in_progress' } } })
        },

        async status(id: string) {
            const creds = await requireCredentials()
            const task = toTask(await taskDetails(creds, id))
            if (task.status === 'failed') {
                task.error = (await turnError(creds, id).catch(() => undefined)) ?? task.error
            }
            return task
        },

        async followup(id: string, prompt: string) {
            const creds = await requireCredentials()
            const details = await taskDetails(creds, id)
            const turnId = details.current_turn_id
            if (!turnId) throw new Error(`Codex Cloud task ${id} has no current turn to follow up on`)
            const body = await call<{ task?: CloudTask } & CloudTask>(creds, 'POST', '/tasks', {
                input_items: [userMessageItem(prompt)],
                follow_up: { task_id: id, turn_id: turnId },
            })
            const task = body.task ?? body
            return toTask(task.id ? { ...details, ...task } : details)
        },

        async stop(id: string) {
            const creds = await requireCredentials()
            await call(creds, 'POST', `/tasks/${encodeURIComponent(id)}/cancel`, {})
        },

        async list() {
            const creds = await requireCredentials()
            const page = await call<{ items?: CloudTask[]; cursor?: string | null }>(creds, 'GET', '/tasks/list?limit=20')
            return (page.items ?? []).map(toTask)
        },
    }
}
