'use client'

import { useLocale } from 'next-intl'
import * as React from 'react'
import { isSetupAnswered } from '@rerun/contracts'
import { Stripes } from '@rerun/ui/primitives'
import { AgentSetupFields, type AgentSetupDraft } from '@/components/agent/AgentSetupFields'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field } from '@/components/ui/field'
import { ChevronRight, FolderIcon, LockIcon, Package, ShieldAlertIcon, ShieldCheck, WrenchIcon } from '@/lib/icons'
import type { AgentCapturePlan } from '@/lib/templates/capture'
import { scheduleLabel } from '@/lib/templates/labels'
import { cn } from '@/lib/utils'
import { CaptureFileTree } from './CaptureFileTree'
import { formatBytes } from '@/lib/files/format'
import { CaptureReviewChips, CaptureReviewGroup, CaptureReviewRow } from './CaptureReviewGroup'
import { flaggedPathSet, planStats } from './capturePlanSummary'

export function CaptureAgentReviewSection({
    plan,
    excluded,
    approved,
    soloAgent,
    setup,
    onToggleFiles,
    onApprove,
    onSetupChange,
}: {
    plan: AgentCapturePlan
    excluded: string[]
    approved: boolean
    soloAgent: boolean
    setup: AgentSetupDraft
    onToggleFiles: (paths: string[], keep: boolean) => void
    onApprove: (next: boolean) => void
    onSetupChange: (next: AgentSetupDraft) => void
}) {
    const locale = useLocale()
    const flagged = React.useMemo(() => flaggedPathSet(plan), [plan])
    const stats = planStats(plan, excluded)
    const [filesOpen, setFilesOpen] = React.useState(stats.flaggedTotal > 0 || soloAgent)

    const travels = plan.connectorSlugs.length + plan.skills.length + plan.schedules.length + plan.triggers.length + plan.tools.length + plan.memoryCount > 0
    const removed = plan.redactions.length + plan.strippedConfigKeys.length > 0
    const toProvide = plan.envKeys.length + plan.mcpAuth.length > 0

    return (
        <div className={cn('flex flex-col gap-3 overflow-hidden rounded-lg border bg-card p-3', approved ? 'border-primary/40' : 'border-border/60')}>
            <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium">{plan.displayName || plan.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {stats.kept} of {stats.total} files, {formatBytes(stats.keptBytes, locale)}
                    </span>
                </div>
                <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                    {plan.name && <span className="shrink-0">@{plan.name}</span>}
                    {plan.description && <span className="truncate">{plan.description}</span>}
                </span>
            </div>

            {travels && (
                <CaptureReviewGroup icon={Package} title="Tools">
                    {plan.tools.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                            <CaptureReviewChips items={plan.tools} max={plan.tools.length} />
                        </div>
                    )}
                    {plan.connectorSlugs.length > 0 && (
                        <CaptureReviewRow label="Apps">
                            <CaptureReviewChips items={plan.connectorSlugs} />
                        </CaptureReviewRow>
                    )}
                    {plan.skills.length > 0 && (
                        <CaptureReviewRow label="Skills">
                            <CaptureReviewChips items={plan.skills.map(skill => skill.name)} max={6} />
                        </CaptureReviewRow>
                    )}
                    {plan.schedules.length > 0 && (
                        <CaptureReviewRow label="Schedules">
                            <CaptureReviewChips items={plan.schedules.map(s => `${s.name}: ${s.cron ? scheduleLabel(s.cron) : 'One-shot'}`)} max={4} />
                        </CaptureReviewRow>
                    )}
                    {plan.triggers.length > 0 && (
                        <CaptureReviewRow label="Webhooks">
                            <CaptureReviewChips items={plan.triggers.map(trigger => `${trigger.name}: ${trigger.methods.join('/')}`)} max={4} />
                        </CaptureReviewRow>
                    )}
                    {plan.memoryCount > 0 && (
                        <CaptureReviewRow label="Memories">
                            <span className="text-[0.7rem] text-muted-foreground">
                                {plan.memoryCount} recorded, excluded from the archive by default
                            </span>
                        </CaptureReviewRow>
                    )}
                </CaptureReviewGroup>
            )}

            {removed && (
                <CaptureReviewGroup icon={ShieldCheck} title="Removed on the way out">
                    {plan.redactions.map(redaction => (
                        <div key={redaction.path} className="flex items-baseline gap-2 text-xs">
                            <span className="shrink-0 font-mono text-foreground/80">{redaction.path}</span>
                            <span className="min-w-0 truncate text-muted-foreground">{redaction.reason}</span>
                        </div>
                    ))}
                    {plan.strippedConfigKeys.length > 0 && (
                        <CaptureReviewRow label="config.json">
                            <CaptureReviewChips items={plan.strippedConfigKeys} mono max={6} />
                        </CaptureReviewRow>
                    )}
                </CaptureReviewGroup>
            )}

            {toProvide && (
                <CaptureReviewGroup icon={LockIcon} title="To provide again on a copy" tone="warning">
                    {plan.envKeys.length > 0 && (
                        <CaptureReviewRow label="Env keys">
                            <CaptureReviewChips items={plan.envKeys} mono max={10} />
                        </CaptureReviewRow>
                    )}
                    {plan.mcpAuth.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                            <CaptureReviewChips items={plan.mcpAuth.map(auth => `${auth.server} (${auth.kind})`)} max={6} />
                        </div>
                    )}
                </CaptureReviewGroup>
            )}

            {stats.flaggedTotal > 0 && (
                <CaptureReviewGroup
                    icon={ShieldAlertIcon}
                    title="Flagged files"
                    tone={stats.flaggedKept.length > 0 ? 'danger' : 'warning'}
                >
                    {stats.flaggedKept.length > 0 ? (
                        <>
                            <p className="text-xs text-destructive">
                                {stats.flaggedKept.length} of {stats.flaggedTotal} files that look like they carry a credential are still included.
                                They will travel inside the archive.
                            </p>
                            <div className="flex flex-wrap gap-1">
                                <CaptureReviewChips items={stats.flaggedKept} mono max={5} />
                            </div>
                        </>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            {stats.flaggedTotal} file{stats.flaggedTotal === 1 ? '' : 's'} look like they carry a credential. They stay out of the
                            archive.
                        </p>
                    )}
                </CaptureReviewGroup>
            )}

            <CaptureReviewGroup icon={WrenchIcon} title="Install">
                <AgentSetupFields
                    value={setup}
                    onChange={next => {
                        onSetupChange(next)
                        // Changing the answer changes what this agent ships. Rewording the
                        // instructions does not, so it leaves a sign-off alone.
                        if (next.required !== setup.required) onApprove(false)
                    }}
                />
            </CaptureReviewGroup>

            <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
                <CaptureReviewGroup icon={FolderIcon} title="Files">
                    <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded py-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                        {filesOpen ? 'Hide the folder' : 'Show the folder'}
                        <span className="ml-auto">
                            {stats.kept} of {stats.total} kept
                        </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <CaptureFileTree
                            files={plan.files}
                            excluded={excluded}
                            onToggle={(paths, keep) => {
                                onToggleFiles(paths, keep)
                                // Putting a flagged file back in changes what was signed off, so the
                                // review has to be given again.
                                if (keep && paths.some(path => flagged.has(path))) onApprove(false)
                            }}
                        />
                    </CollapsibleContent>
                </CaptureReviewGroup>
            </Collapsible>

            <div className="relative -mx-3 -mb-3 mt-auto overflow-hidden border-t border-border/60 bg-amber-500/[0.02] px-3 py-2.5">
                <Stripes fade="vertical" color="rgb(245 158 11 / 0.06)" />
                <Field
                    className="relative"
                    orientation="row"
                    label="I reviewed what this coworker carries"
                    helperText={
                        setup.required === null
                            ? 'Answer the install question above first.'
                            : !isSetupAnswered(setup)
                              ? 'Write the install instructions above first.'
                              : stats.flaggedKept.length > 0
                                ? `${stats.flaggedKept.length} flagged file(s) will travel inside the archive.`
                                : 'Nothing on this list is a secret that should not ship.'
                    }
                >
                    <Checkbox size="sm" disabled={!isSetupAnswered(setup)} checked={approved} onCheckedChange={value => onApprove(value === true)} />
                </Field>
            </div>
        </div>
    )
}
