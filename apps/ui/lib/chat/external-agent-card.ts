import type { ExternalAgentStatus } from '@rerun/contracts'

export { externalAgentCardOf, externalAgentTaskSchema, EXTERNAL_AGENT_STATUSES } from '@rerun/contracts'
export type { ExternalAgentCard, ExternalAgentStatus, ExternalAgentTask } from '@rerun/contracts'

const LIVE_STATUSES: ReadonlySet<ExternalAgentStatus> = new Set(['queued', 'running', 'unknown'])

export function externalAgentTaskLive(status: ExternalAgentStatus): boolean {
    return LIVE_STATUSES.has(status)
}
