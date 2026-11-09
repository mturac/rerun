'use client'

import { StepRow } from '@/components/chat/StepRow'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Icon } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { formatNumber } from '@rerun/i18n/format'
import { BorderBeam } from '@rerun/ui'
import { CheckCircle2Icon, ChevronRightIcon, FoldVerticalIcon, XCircleIcon } from '@/lib/icons'
import { useLocale } from 'next-intl'
import { useEffect, useState } from 'react'

export type CompactionData = {
    status: 'running' | 'done' | 'error'
    messagesCompacted?: number
    tokensRecovered?: number
}

const compactionLabel = (status: CompactionData['status']) => (status === 'running' ? 'Compacting context…' : status === 'error' ? 'Context compaction failed' : 'Context compacted')

/** The compaction on one line of the folded steps. */
export function CompactionStep({ data }: { data: CompactionData }) {
    const locale = useLocale()
    const settled = data.status === 'done'
    const summarized = settled && typeof data.messagesCompacted === 'number' ? `${data.messagesCompacted} earlier messages summarized` : undefined
    const recovered = settled && typeof data.tokensRecovered === 'number' ? `~${formatNumber(data.tokensRecovered, locale)} tokens recovered` : undefined
    return <StepRow iconProps={{ icon: FoldVerticalIcon }} label={compactionLabel(data.status)} detail={[summarized, recovered].filter(Boolean).join(' · ')} status={data.status} />
}

export function CompactionBlock({ data }: { data: CompactionData }) {
    const locale = useLocale()
    const isRunning = data.status === 'running'
    const hasContent = data.status === 'done' && (typeof data.messagesCompacted === 'number' || typeof data.tokensRecovered === 'number')
    const [open, setOpen] = useState(false)
    useEffect(() => { setOpen(false) }, [data.status])

    const label = compactionLabel(data.status)

    return (
        <Collapsible open={open && hasContent} onOpenChange={setOpen} className="relative rounded-xl transition-colors data-[state=open]:bg-muted/40">
            {isRunning && <BorderBeam animated pattern="arcs" tone="brand" glow width={1} duration={5} />}
            <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-xl px-1.5 py-1.5 text-left text-sm transition-colors data-[state=closed]:hover:bg-muted/40">
                <Icon icon={FoldVerticalIcon} size="sm" />
                <div className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{label}</span>
                </div>
                {data.status === 'running' && <Spinner className="size-3.5 shrink-0 text-amber-400" />}
                {data.status === 'done' && <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-400" />}
                {data.status === 'error' && <XCircleIcon className="size-3.5 shrink-0 text-red-400" />}
                {hasContent && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />}
            </CollapsibleTrigger>

            {hasContent && (
                <CollapsibleContent>
                    <div className="mx-1.5 border-t border-border/60 pt-2 pb-3 text-xs text-muted-foreground">
                        {typeof data.messagesCompacted === 'number' && <p>{data.messagesCompacted} earlier messages summarized</p>}
                        {typeof data.tokensRecovered === 'number' && <p>~{formatNumber(data.tokensRecovered, locale)} tokens recovered</p>}
                    </div>
                </CollapsibleContent>
            )}
        </Collapsible>
    )
}
