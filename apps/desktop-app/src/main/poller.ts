import type { EngineClient, PendingApproval, RunRow } from './engine-client.js'

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled'])
const MAX_AGENTS = 30

export interface PollerDeps {
    client: EngineClient
    intervalMs: number
    onApprovalCount: (count: number) => void
    onEngineReachable: (reachable: boolean) => void
    notify: (title: string, body: string) => void
}

export class DesktopPoller {
    private timer: NodeJS.Timeout | null = null
    private seenApprovals = new Set<string>()
    private runStates = new Map<string, string>()
    private seededAgents = new Set<string>()
    private ticking = false

    constructor(private readonly deps: PollerDeps) {}

    start(): void {
        if (this.timer) return
        void this.tick()
        this.timer = setInterval(() => void this.tick(), this.deps.intervalMs)
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    private async tick(): Promise<void> {
        if (this.ticking) return
        this.ticking = true
        try {
            await this.pollApprovals()
            await this.pollRuns()
            this.deps.onEngineReachable(true)
        } catch {
            this.deps.onEngineReachable(false)
        } finally {
            this.ticking = false
        }
    }

    private async pollApprovals(): Promise<void> {
        const approvals = await this.deps.client.pendingApprovals()
        this.deps.onApprovalCount(approvals.length)
        const current = new Set(approvals.map(a => a.id))
        for (const approval of approvals) {
            if (this.seenApprovals.has(approval.id)) continue
            this.notifyApproval(approval)
        }
        this.seenApprovals = current
    }

    private notifyApproval(approval: PendingApproval): void {
        const who = approval.runnerName ? ` on ${approval.runnerName}` : ''
        const what = approval.approvalText ?? approval.subject ?? approval.action ?? approval.kind ?? 'action'
        this.deps.notify(`Runner approval needed${who}`, String(what))
    }

    private async pollRuns(): Promise<void> {
        const agents = (await this.deps.client.agents()).slice(0, MAX_AGENTS)
        for (const agent of agents) {
            const runs = await this.deps.client.recentRuns(agent.id)
            const key = (run: RunRow) => `${agent.id}/${run.id}`
            if (!this.seededAgents.has(agent.id)) {
                for (const run of runs) this.runStates.set(key(run), run.status)
                this.seededAgents.add(agent.id)
                continue
            }
            for (const run of runs) {
                const k = key(run)
                const previous = this.runStates.get(k)
                this.runStates.set(k, run.status)
                if (previous === run.status) continue
                if (TERMINAL_STATUSES.has(run.status)) {
                    this.notifyRun(agent.id, run)
                }
            }
        }
    }

    private notifyRun(agentId: string, run: RunRow): void {
        const title = run.status === 'done' ? 'Run finished' : `Run ${run.status}`
        const body = run.error ? String(run.error).slice(0, 200) : `Agent ${agentId} · run ${run.id}`
        this.deps.notify(title, body)
    }
}
