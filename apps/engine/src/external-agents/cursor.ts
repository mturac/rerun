import type { ExternalAgentLaunch, ExternalAgentProvider, ExternalAgentStatus, ExternalAgentTask } from './types.js'

const BASE_URL = 'https://api.cursor.com'

type CursorAgent = {
    id?: string
    name?: string
    status?: string
    summary?: string
    source?: { repository?: string; ref?: string }
    target?: { branchName?: string; url?: string; prUrl?: string }
    createdAt?: string
}

function toStatus(status: string | undefined): ExternalAgentStatus {
    switch (status) {
        case 'CREATING':
        case 'RUNNING':
        case 'STOPPED':
            return 'running'
        case 'FINISHED':
            return 'completed'
        case 'ERROR':
        case 'FAILED':
        case 'EXPIRED':
            return 'failed'
        default:
            return status ? 'unknown' : 'unknown'
    }
}

function toTask(agent: CursorAgent): ExternalAgentTask {
    const status = toStatus(agent.status)
    return {
        provider: 'cursor',
        id: agent.id ?? '',
        name: agent.name ?? '',
        status,
        url: agent.target?.url,
        prUrl: agent.target?.prUrl,
        summary: agent.summary,
        branch: agent.target?.branchName,
        raw: agent,
    }
}

export function cursorProvider(apiKey: string, fetchImpl: typeof fetch = fetch): ExternalAgentProvider {
    const headers = {
        authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        'content-type': 'application/json',
    }

    async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await fetchImpl(`${BASE_URL}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new Error(`Cursor API ${method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`)
        }
        return (await res.json()) as T
    }

    return {
        name: 'cursor',
        isConfigured: () => apiKey.length > 0,

        async launch(input: ExternalAgentLaunch) {
            const agent = await call<CursorAgent>('POST', '/v0/agents', {
                prompt: input.prompt,
                ...(input.repository || input.ref
                    ? { source: { ...(input.repository ? { repository: input.repository } : {}), ...(input.ref ? { ref: input.ref } : {}) } }
                    : {}),
                ...(input.branchName || input.autoCreatePr !== undefined
                    ? { target: { ...(input.branchName ? { branchName: input.branchName } : {}), ...(input.autoCreatePr !== undefined ? { autoCreatePr: input.autoCreatePr } : {}) } }
                    : {}),
                ...(input.model ? { model: input.model } : {}),
            })
            return toTask(agent)
        },

        async status(id: string) {
            const agent = await call<CursorAgent>('GET', `/v0/agents/${encodeURIComponent(id)}`)
            return toTask(agent)
        },

        async followup(id: string, prompt: string) {
            const agent = await call<CursorAgent>('POST', `/v0/agents/${encodeURIComponent(id)}/followup`, { prompt })
            return toTask(agent)
        },

        async stop(id: string) {
            await call('POST', `/v0/agents/${encodeURIComponent(id)}/stop`)
        },

        async list() {
            const page = await call<{ agents?: CursorAgent[] }>('GET', '/v0/agents?limit=50')
            return (page.agents ?? []).map(toTask)
        },
    }
}
