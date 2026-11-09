'use client'

import { Badge, Card } from '@rerun/ui/primitives'
import { TemplateBoardPreview, type BoardAgent } from '@rerun/ui/iso-grid'
import type { TemplateConnector } from '@rerun/contracts'
import { useLocale } from 'next-intl'
import { useMemo } from 'react'

import { formatDuration, toolLabel } from '@/lib/rewind/format'
import { TrophyIcon } from '@/lib/icons'
import { RewindCount } from '../RewindCount'
import { RewindHeadline, RewindReveal, RewindSlideFrame } from '../RewindSlideFrame'
import type { RewindSlideProps } from './types'

export function MvpSlide({ payload, wide }: RewindSlideProps) {
    const locale = useLocale()
    const mvp = payload.agents.find(agent => agent.agentId === payload.mvpAgentId)
    const board = useMemo(() => {
        if (!mvp) return null
        const agents: BoardAgent[] = [{ key: mvp.agentId, name: mvp.name, connectorSlugs: mvp.connectors }]
        const connectors: TemplateConnector[] = payload.connectors.filter(c => mvp.connectors.includes(c.slug)).map(c => ({ slug: c.slug, name: c.name, icon: c.icon }))
        return { agents, connectors }
    }, [mvp, payload.connectors])
    if (!mvp || !board) return null

    const share = payload.totals.runs ? Math.round((mvp.runs / payload.totals.runs) * 100) : 0

    return (
        <RewindSlideFrame
            tone="amber"
            eyebrow="Coworker of the week"
            visual={
                <>
                    <div className="relative -mx-6 h-[34cqh] rewind-wide:mx-0 rewind-wide:h-auto rewind-wide:min-h-0 rewind-wide:flex-1">
                        <TemplateBoardPreview agents={board.agents} connectors={board.connectors} alive maxZoom={wide ? 4 : 2.6} className="size-full" />
                    </div>
                    <RewindReveal delay={1} className="mt-4 grid grid-cols-3 gap-2">
                        <Stat label="runs" value={<RewindCount value={mvp.runs} delay={1.1} />} />
                        <Stat label="of all work" value={<RewindCount value={share} delay={1.2} suffix="%" />} />
                        <Stat label="on the clock" value={formatDuration(mvp.workedMs, locale)} />
                    </RewindReveal>
                    {mvp.topTools.length > 0 && (
                        <RewindReveal delay={1.6} className="mt-3 text-sm text-white/80">
                            Go-to moves: {mvp.topTools.map(toolLabel).join(', ')}.
                        </RewindReveal>
                    )}
                </>
            }
        >
            <RewindReveal delay={0.1}>
                <Badge tone="yellow" size="sm" leading={<TrophyIcon className="size-3.5" />}>
                    MVP
                </Badge>
            </RewindReveal>
            <RewindHeadline className="mt-3 text-[3rem]/[1.05] break-words rewind-wide:text-[min(4.5rem,13cqh)]/[1.02]">{mvp.name}</RewindHeadline>
            {mvp.spaceName && (
                <RewindReveal delay={0.4} className="text-sm text-white/70 rewind-wide:mt-2 rewind-wide:text-base">
                    in {mvp.spaceName}
                </RewindReveal>
            )}
        </RewindSlideFrame>
    )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <Card size="sm" className="gap-0 bg-card/60 px-3 backdrop-blur-sm">
            <div className="text-2xl font-semibold">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
        </Card>
    )
}
