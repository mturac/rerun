'use client'

import { useCallback, useState } from 'react'

import type { BadgeTone } from '@rerun/ui/primitives'
import { Badge, PANEL_CARD } from '@rerun/ui/primitives'
import type { ExternalAgentCard as ExternalAgentCardData, ExternalAgentStatus, ExternalAgentTask } from '@rerun/contracts'

import { Icon } from '@/components/ui/icon'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { CloudIcon, ExternalLinkIcon, GitPullRequest } from '@/lib/icons'
import { externalAgentEventLines, externalAgentTaskLive, externalAgentTaskSchema } from '@/lib/chat/external-agent-card'
import { cn } from '@/lib/utils'

const STATUS_TONES: Record<ExternalAgentStatus, BadgeTone> = {
    queued: 'neutral',
    running: 'cyan',
    completed: 'green',
    failed: 'red',
    stopped: 'neutral',
    unknown: 'neutral',
}

const STATUS_LABELS: Record<ExternalAgentStatus, string> = {
    queued: 'Queued',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
    unknown: 'Unknown',
}

const ACTION_LABELS: Record<ExternalAgentCardData['action'], string> = {
    started: 'Started a cloud agent',
    checked: 'Checked a cloud agent',
    'followed-up': 'Sent a follow-up to a cloud agent',
}

const POLL_MS = 15000

function statusLabel(status: ExternalAgentStatus): string {
    return STATUS_LABELS[status]
}

function ExternalAgentTaskPoller({ agentId, provider, taskId, onTask }: { agentId: string; provider: string; taskId: string; onTask: (task: ExternalAgentTask) => void }) {
    const poll = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/external-agents/${encodeURIComponent(provider)}/${encodeURIComponent(taskId)}`)
            if (!res.ok) return
            const parsed = externalAgentTaskSchema.safeParse(((await res.json()) as { task?: unknown }).task)
            if (parsed.success) onTask(parsed.data)
        } catch {}
    }, [agentId, provider, taskId, onTask])
    useVisibleInterval(poll, POLL_MS)
    return null
}

function LiveExternalAgentCard({ card, agentId }: { card: ExternalAgentCardData; agentId: string }) {
    const [task, setTask] = useState(card.task)
    return (
        <>
            {externalAgentTaskLive(task.status) && <ExternalAgentTaskPoller agentId={agentId} provider={card.provider} taskId={card.task.id} onTask={setTask} />}
            <ExternalAgentCardView card={card} task={task} />
        </>
    )
}

function ExternalAgentCardView({ card, task }: { card: ExternalAgentCardData; task: ExternalAgentTask }) {
    const title = task.name || task.id || 'Cloud agent task'
    const links = [
        task.prUrl ? { href: task.prUrl, label: 'Pull request', icon: GitPullRequest } : null,
        task.url ? { href: task.url, label: 'Open in ' + card.providerLabel, icon: ExternalLinkIcon } : null,
    ].filter(link => link !== null)

    return (
        <div className={cn(PANEL_CARD, 'flex flex-col gap-2 px-3 py-3')}>
            <div className="flex items-center gap-2">
                <Icon icon={CloudIcon} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
                <Badge size="xs" tone={STATUS_TONES[task.status]} glow={false} className="shrink-0 font-medium">
                    {statusLabel(task.status)}
                </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
                {ACTION_LABELS[card.action]} on {card.providerLabel}
                {task.branch ? ` · ${task.branch}` : ''}
            </p>
            {task.summary && <p className="line-clamp-3 text-sm text-foreground/90">{task.summary}</p>}
            {(() => {
                const lines = externalAgentEventLines(task.events)
                return lines.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
                        {lines.map((line, i) => (
                            <li key={i} className="truncate text-xs text-muted-foreground">
                                {line}
                            </li>
                        ))}
                    </ul>
                ) : null
            })()}
            {task.error && <p className="line-clamp-2 text-xs text-destructive">{task.error}</p>}
            {links.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {links.map(link => (
                        <a
                            key={link.href}
                            href={link.href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                            <link.icon className="size-3" />
                            {link.label}
                        </a>
                    ))}
                </div>
            )}
        </div>
    )
}

export function ExternalAgentCard({ card, agentId }: { card: ExternalAgentCardData; agentId?: string }) {
    if (agentId && card.task.id && externalAgentTaskLive(card.task.status)) return <LiveExternalAgentCard card={card} agentId={agentId} />
    return <ExternalAgentCardView card={card} task={card.task} />
}
