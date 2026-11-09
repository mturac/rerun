'use client'

import { formatNumber } from '@rerun/i18n/format'
import { useLocale } from 'next-intl'
import { useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { dayLabel, runsOutOn, sourceKey, sourceLabel, type CreditBalance, type CreditUsage } from '@/ee/lib/billing/credit-usage'
import { shortDate } from '@/ee/lib/billing/dates'
import { formatCredits } from '@/ee/lib/billing/plans'
import { cn } from '@/lib/utils'

import { RightTitle } from '../parts'
import { CoworkerAvatar, KIND_FILL, SourceChip, Swatch } from './parts'
import { UsageChart, type ChartMode } from './UsageChart'
import type { CreditUsageState } from './useCreditUsage'

type Breakdown = 'source' | 'coworker'

const DAY_MS = 86_400_000

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
    return (
        <div className="flex w-fit gap-0.5 rounded-lg bg-background/60 p-0.5 ring-1 ring-border">
            {options.map(option => (
                <button key={option.id} type="button" onClick={() => onChange(option.id)} className={cn('rounded-md px-2.5 py-1 text-xs transition-colors', value === option.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                    {option.label}
                </button>
            ))}
        </div>
    )
}

const callsLabel = (calls: number, locale: string) => `${formatNumber(calls, locale)} ${calls === 1 ? 'call' : 'calls'}`

function BySource({ usage }: { usage: CreditUsage }) {
    const locale = useLocale()
    const max = Math.max(...usage.bySource.map(total => total.micros), 1)
    const groups = [
        { kind: 'ai' as const, title: 'AI models', rows: usage.bySource.filter(total => total.source.kind === 'ai') },
        { kind: 'data' as const, title: 'Paid data', rows: usage.bySource.filter(total => total.source.kind === 'data') },
    ].filter(group => group.rows.length > 0)

    return (
        <div className="flex flex-col gap-4">
            {groups.map(group => (
                <div key={group.kind} className="flex flex-col gap-2.5">
                    <p className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                            <Swatch kind={group.kind} />
                            {group.title}
                        </span>
                        <span className="tabular-nums">{formatCredits(group.rows.reduce((sum, row) => sum + row.micros, 0), locale)}</span>
                    </p>
                    {group.rows.map(total => (
                        <div key={sourceKey(total.source)} className="flex items-center gap-3 text-sm">
                            <SourceChip source={total.source} />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-2">
                                    <span className="truncate">{sourceLabel(total.source)}</span>
                                    <span className="tabular-nums">{formatCredits(total.micros, locale)}</span>
                                </div>
                                <div className="mt-1 flex items-center gap-2">
                                    <div className="h-1 flex-1 rounded-full bg-muted-foreground/15">
                                        <div className={cn('h-full rounded-full', KIND_FILL[total.source.kind])} style={{ width: `${(total.micros / max) * 100}%` }} />
                                    </div>
                                    <span className="w-20 text-right text-[11px] text-muted-foreground">{callsLabel(total.calls, locale)}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    )
}

function ByCoworker({ usage }: { usage: CreditUsage }) {
    const locale = useLocale()
    const max = Math.max(...usage.byCoworker.map(total => total.aiMicros + total.dataMicros), 1)
    return (
        <div className="flex flex-col gap-3">
            {usage.byCoworker.map(total => {
                const sum = total.aiMicros + total.dataMicros
                return (
                    <div key={total.coworker?.id ?? 'other'} className="flex items-center gap-3 text-sm">
                        <CoworkerAvatar coworker={total.coworker} />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className={cn('truncate', !total.coworker && 'text-muted-foreground')}>{total.coworker?.name ?? 'Other'}</span>
                                <span className="tabular-nums">{formatCredits(sum, locale)}</span>
                            </div>
                            <div className="mt-1 flex h-1 gap-px" style={{ width: `${(sum / max) * 100}%` }}>
                                {total.aiMicros > 0 && <div className={cn('h-full rounded-l-full', KIND_FILL.ai, total.dataMicros === 0 && 'rounded-r-full')} style={{ flexGrow: total.aiMicros }} />}
                                {total.dataMicros > 0 && <div className={cn('h-full rounded-r-full', KIND_FILL.data, total.aiMicros === 0 && 'rounded-l-full')} style={{ flexGrow: total.dataMicros }} />}
                            </div>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

function LatestCharges({ usage }: { usage: CreditUsage }) {
    const locale = useLocale()
    return (
        <ul className="flex flex-col divide-y divide-border">
            {usage.latest.map(charge => (
                <li key={`${charge.day}-${charge.coworker?.id ?? 'other'}-${sourceKey(charge.source)}`} className="flex items-center gap-3 py-2.5 text-sm first:pt-0">
                    <SourceChip source={charge.source} />
                    <div className="min-w-0 flex-1">
                        <p className="truncate">
                            {sourceLabel(charge.source)} <span className="text-muted-foreground">· {charge.coworker?.name ?? 'Other'}</span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                            {dayLabel(charge.day, locale)} · {callsLabel(charge.calls, locale)}
                        </p>
                    </div>
                    <span className="tabular-nums">−{formatCredits(charge.micros, locale)}</span>
                </li>
            ))}
        </ul>
    )
}

// What to say when the credit will not last: nothing when it does, nor once it is gone, the card
// says that one.
function paceNote(balance: CreditBalance, usage: CreditUsage, trial: boolean, locale: string): string | null {
    if (balance.leftMicros <= 0) return null
    if (!trial && balance.monthLeftMicros === 0 && balance.topupLeftMicros > 0) return `This month's credits are spent. Coworkers now draw on your top-up, ${formatCredits(balance.topupLeftMicros, locale)} left.`
    const out = runsOutOn(balance, usage.period, new Date())
    if (!out) return null
    const early = Math.round((new Date(usage.period.end).getTime() - out.getTime()) / DAY_MS)
    return `At this pace, you run out around ${shortDate(out, locale)}, ${early} ${early === 1 ? 'day' : 'days'} before ${trial ? 'your trial ends' : 'the reset'}.`
}

function UsageSkeleton() {
    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-end justify-between">
                <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-7 w-40" />
                    <Skeleton className="h-3.5 w-32" />
                </div>
                <Skeleton className="h-7 w-28 rounded-lg" />
            </div>
            <Skeleton className="h-40 w-full rounded-lg" />
            <Skeleton className="h-7 w-44 rounded-lg" />
            {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-center gap-3">
                    <Skeleton className="size-7 rounded-lg" />
                    <div className="flex flex-1 flex-col gap-1.5">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-1 w-full" />
                    </div>
                </div>
            ))}
        </div>
    )
}

// The drill-in on the right of a billing dialog, like Card and Invoices: where the credit went this
// period, by day, by source or by coworker, and the latest charges.
export function UsagePane({ credit, onBack, backLabel }: { credit: CreditUsageState; onBack: () => void; backLabel?: string }) {
    const locale = useLocale()
    const [mode, setMode] = useState<ChartMode>('daily')
    const [breakdown, setBreakdown] = useState<Breakdown>('source')
    const { balance, usage, trial } = credit

    const body = (() => {
        if (!balance) return <UsageSkeleton />
        if (!usage) return <p className="text-sm text-muted-foreground">Your credit usage could not be loaded. Try again in a moment.</p>
        const pace = paceNote(balance, usage, trial, locale)
        return (
            <>
                <div className="flex items-end justify-between gap-4">
                    <div>
                        <p className="text-2xl font-semibold tabular-nums">
                            {formatCredits(balance.usedAiMicros + balance.usedDataMicros, locale)} <span className="text-sm font-normal text-muted-foreground">credits used</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {shortDate(usage.period.start, locale)} – {shortDate(usage.period.end, locale)} · {formatCredits(balance.leftMicros, locale)} left
                        </p>
                    </div>
                    <Segmented
                        value={mode}
                        onChange={setMode}
                        options={[
                            { id: 'daily', label: 'Per day' },
                            { id: 'cumulative', label: 'Pace' },
                        ]}
                    />
                </div>
                <div className="flex flex-col gap-3">
                    <UsageChart usage={usage} balance={balance} trial={trial} mode={mode} />
                    {pace && <p className="text-xs text-orange-500 dark:text-orange-400">{pace}</p>}
                </div>

                {usage.bySource.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing spent yet this {trial ? 'trial' : 'period'}.</p>
                ) : (
                    <>
                        <div className="flex flex-col gap-4">
                            <Segmented
                                value={breakdown}
                                onChange={setBreakdown}
                                options={[
                                    { id: 'source', label: 'By source' },
                                    { id: 'coworker', label: 'By coworker' },
                                ]}
                            />
                            {breakdown === 'source' ? <BySource usage={usage} /> : <ByCoworker usage={usage} />}
                        </div>

                        <div className="flex flex-col gap-3">
                            <p className="text-xs font-medium text-muted-foreground">Latest charges</p>
                            <LatestCharges usage={usage} />
                        </div>
                    </>
                )}
            </>
        )
    })()

    return (
        <div className="flex flex-col gap-6">
            <RightTitle onBack={onBack} backLabel={backLabel}>
                Credit usage
            </RightTitle>
            {body}
        </div>
    )
}
