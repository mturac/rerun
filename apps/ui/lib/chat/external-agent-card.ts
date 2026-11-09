import type { ExternalAgentStatus } from '@rerun/contracts'

export { externalAgentCardOf, externalAgentTaskSchema, EXTERNAL_AGENT_STATUSES } from '@rerun/contracts'
export type { ExternalAgentCard, ExternalAgentStatus, ExternalAgentTask } from '@rerun/contracts'

const LIVE_STATUSES: ReadonlySet<ExternalAgentStatus> = new Set(['queued', 'running', 'unknown'])

export function externalAgentTaskLive(status: ExternalAgentStatus): boolean {
    return LIVE_STATUSES.has(status)
}

const EVENT_LIFECYCLE: Record<string, string> = {
    'thread.started': 'Started',
    'turn.started': 'Working',
    'turn.completed': 'Turn finished',
    'session.started': 'Started',
    'session.idle': 'Idle',
}

function clip(text: string, max = 140): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function externalAgentEventLine(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null
    const e = event as Record<string, any>
    const item = e.item && typeof e.item === 'object' ? (e.item as Record<string, any>) : undefined

    if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) return clip(item.text)
    if (item?.type === 'error') return typeof item.message === 'string' ? `Error: ${clip(item.message, 120)}` : 'Error'
    if (e.type === 'result' && typeof e.result === 'string' && e.result.trim()) return clip(e.result)

    const content = e.message?.content ?? e.content ?? item?.content
    if (Array.isArray(content)) {
        const text = content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('')
        if (text.trim()) return clip(text)
    }
    const toolName = e.tool_name ?? e.name ?? item?.name ?? item?.tool_name
    const command = e.command ?? item?.command
    if (typeof command === 'string' && command.trim()) return `$ ${clip(command, 100)}`
    if (typeof toolName === 'string' && toolName.trim()) return clip(toolName)
    if (typeof e.type === 'string' && EVENT_LIFECYCLE[e.type]) return EVENT_LIFECYCLE[e.type]
    return null
}

export function externalAgentEventLines(events: unknown[] | undefined, limit = 4): string[] {
    if (!events?.length) return []
    const lines: string[] = []
    for (let i = events.length - 1; i >= 0 && lines.length < limit; i--) {
        const line = externalAgentEventLine(events[i])
        if (line) lines.unshift(line)
    }
    return lines
}
