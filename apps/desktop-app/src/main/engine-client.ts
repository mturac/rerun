export interface PendingApproval {
    id: string
    approvalText?: string
    taskKey?: string
    action?: string
    kind?: string
    subject?: string | null
    expiresAt?: string
    runnerId?: string
    runnerName?: string
}

export interface AgentIndexRow {
    id: string
    name?: string
}

export interface RunRow {
    id: string
    agentId?: string
    sessionId?: string
    status: string
    startedAt?: string
    finishedAt?: string | null
    error?: string | null
}

export interface EngineHealth {
    status: string
    activeRuns?: number
    activeAgents?: number
}

export class EngineClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
    ) {}

    private async get<T>(path: string, timeoutMs = 10_000): Promise<T> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            headers: { authorization: `Bearer ${this.apiKey}` },
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`)
        return (await res.json()) as T
    }

    async health(): Promise<EngineHealth> {
        return this.get<EngineHealth>('/health', 3_000)
    }

    async pendingApprovals(): Promise<PendingApproval[]> {
        const body = await this.get<{ approvals?: PendingApproval[] }>('/local-runner/pending')
        return body.approvals ?? []
    }

    async agents(): Promise<AgentIndexRow[]> {
        const body = await this.get<{ agents?: AgentIndexRow[] }>('/agents')
        return body.agents ?? []
    }

    async recentRuns(agentId: string, limit = 15): Promise<RunRow[]> {
        const body = await this.get<{ runs?: RunRow[] }>(`/agents/${encodeURIComponent(agentId)}/runs?limit=${limit}`)
        return body.runs ?? []
    }
}
