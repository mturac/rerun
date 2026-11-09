import { z } from 'zod'

import { parseHubOutput } from './tool-output.js'

export const EXTERNAL_AGENT_STATUSES = ['queued', 'running', 'completed', 'failed', 'stopped', 'unknown'] as const
export type ExternalAgentStatus = (typeof EXTERNAL_AGENT_STATUSES)[number]

export const externalAgentTaskSchema = z.object({
    provider: z.string().catch(''),
    id: z.string().catch(''),
    name: z.string().catch(''),
    status: z.enum(EXTERNAL_AGENT_STATUSES).catch('unknown'),
    url: z.string().optional().catch(undefined),
    prUrl: z.string().optional().catch(undefined),
    summary: z.string().optional().catch(undefined),
    branch: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
})
export type ExternalAgentTask = z.infer<typeof externalAgentTaskSchema>

export type ExternalAgentCard = {
    provider: string
    providerLabel: string
    action: 'started' | 'checked' | 'followed-up'
    task: ExternalAgentTask
}

const PROVIDER_LABELS: Record<string, string> = {
    cursor: 'Cursor',
    codex: 'Codex',
    'codex-cli': 'Codex CLI',
    'claude-cli': 'Claude',
}

const CARD_TOOLS = {
    external_agent_start: 'started',
    external_agent_status: 'checked',
    external_agent_followup: 'followed-up',
} as const satisfies Record<string, ExternalAgentCard['action']>

function providerLabelOf(provider: string): string {
    if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]
    return provider.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function externalAgentCardOf(toolName: string, output: unknown): ExternalAgentCard | null {
    const action = CARD_TOOLS[toolName as keyof typeof CARD_TOOLS]
    if (!action) return null
    const value = parseHubOutput<{ ok?: unknown; provider?: unknown; task?: unknown }>(output)
    if (!value || value.ok !== true || !value.task || typeof value.task !== 'object') return null
    const task = externalAgentTaskSchema.safeParse(value.task)
    if (!task.success) return null
    const provider = typeof value.provider === 'string' && value.provider ? value.provider : task.data.provider
    return { provider, providerLabel: providerLabelOf(provider), action, task: task.data }
}
