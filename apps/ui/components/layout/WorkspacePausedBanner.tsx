'use client'

import { getSandboxArchiveStateAction, getWorkspaceRestoreStageAction, type SandboxArchiveState } from '@/app/api/_actions/workspace-restore.actions'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { RequestSandboxReactivationDialog } from '@/components/dialogs/RequestSandboxReactivationDialog'
import { Button } from '@/components/ui/button'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { useWorkspaceAccess } from '@/hooks/useWorkspaceAccess'
import type { RestoreStage } from '@/lib/archive/restore-stage'
import { AlertCircleIcon, ArchiveIcon, CircleCheckIcon, ClockIcon, LoaderIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useBillingStore } from '@/stores/billing.store'
import { useSandboxArchiveStore } from '@/stores/sandbox-archive.store'
import { useSession } from '@/supabase/session/SessionProvider'
import { formatDate } from '@rerun/i18n/format'
import { ChromeBar } from '@rerun/ui/chrome'
import { useLocale } from 'next-intl'
import { useCallback, useState } from 'react'

const RESTORE_STEPS: readonly { stage: Exclude<RestoreStage, 'waiting' | 'failed'>; label: string; activeLabel?: string }[] = [
    { stage: 'machine', label: 'Machine assigned', activeLabel: 'Assigning a machine' },
    { stage: 'data', label: 'Restoring your data' },
    { stage: 'agents', label: 'Waking your coworkers' },
]

const STAGE_POLL_MS = 4000
// An approval is a human's doing: nothing here changes by the second.
const SANDBOX_ARCHIVE_POLL_MS = 15_000

export function formatKeptUntil(date: Date, locale: string): string {
    return formatDate(date, locale, { month: 'short', day: 'numeric' })
}

// The board of a workspace whose machine was archived when its plan ended, and of one coming back
// after a payment. The agents stay drawn, locked: this is the one place that says why and how out.
export function WorkspacePausedBanner() {
    const { access, keptUntil, paymentFailed, sandboxArchived } = useWorkspaceAccess()
    const { workspace } = useSession()
    const isSandbox = !!workspace?.is_sandbox
    if (access === 'live') return null

    return (
        <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--chrome-edge)+var(--chrome-size)+var(--chrome-gap))] z-30 flex justify-center px-4 md:top-(--chrome-edge)">
            <ChromeBar start="icon" className="pointer-events-auto max-w-full font-normal md:max-w-[calc(100%-26rem)]">
                {isSandbox && workspace && <SandboxArchiveSync workspaceId={workspace.id} />}
                {sandboxArchived ? <SandboxArchivedBanner keptUntil={keptUntil} /> : access === 'paused' ? <PausedContent keptUntil={keptUntil} paymentFailed={paymentFailed} /> : <RestoringContent approved={isSandbox} />}
            </ChromeBar>
        </div>
    )
}

export function PausedContent({ keptUntil, paymentFailed = false }: { keptUntil: Date | null; paymentFailed?: boolean }) {
    const locale = useLocale()
    return (
        <>
            <ArchiveIcon className="relative size-4 shrink-0 text-muted-foreground" />
            <p className="relative min-w-0 truncate text-sm">
                <span className="font-medium">{paymentFailed ? 'Payment failed, workspace paused.' : 'Workspace paused.'}</span>{' '}
                <span className="text-muted-foreground max-sm:hidden">Your coworkers and their data are saved{keptUntil ? ` until ${formatKeptUntil(keptUntil, locale)}` : ''}.</span>
            </p>
            <Button className="shrink-0 rounded-full px-3" onClick={() => useBillingStore.getState().openBilling(undefined, 'paused_banner')}>
                {paymentFailed ? 'Update payment' : 'Subscribe to restore'}
            </Button>
        </>
    )
}

// Keeps the store in step with the server for as long as the banner shows: an approval turns the
// sandbox to restoring, and a restore that landed clears the store once the session has caught up.
function SandboxArchiveSync({ workspaceId }: { workspaceId: number }) {
    const refresh = useCallback(() => {
        getSandboxArchiveStateAction()
            .then(archive => useSandboxArchiveStore.getState().setArchive(workspaceId, archive))
            .catch(() => {})
    }, [workspaceId])
    useVisibleInterval(refresh, SANDBOX_ARCHIVE_POLL_MS)
    return null
}

const SANDBOX_REQUESTED_REASON = 'We are reviewing your request'

// The connected half: reads what the server said, and owns the request dialog.
function SandboxArchivedBanner({ keptUntil }: { keptUntil: Date | null }) {
    const { workspace } = useSession()
    const stored = useSandboxArchiveStore(s => (workspace && s.workspaceId === workspace.id ? s.archive : null))
    const [requesting, setRequesting] = useState(false)
    const markRequested = () => {
        if (workspace) useSandboxArchiveStore.getState().setArchive(workspace.id, { status: 'requested', keptUntil: stored?.keptUntil ?? null })
    }

    return (
        <>
            <SandboxArchivedContent keptUntil={keptUntil} status={stored?.status ?? 'none'} onRequest={() => setRequesting(true)} />
            <RequestSandboxReactivationDialog open={requesting} onOpenChange={setRequesting} onRequested={markRequested} />
        </>
    )
}

export function SandboxArchivedContent({ keptUntil, status, onRequest }: { keptUntil: Date | null; status: SandboxArchiveState['status']; onRequest?: () => void }) {
    const locale = useLocale()
    return (
        <>
            <ArchiveIcon className="relative size-4 shrink-0 text-muted-foreground" />
            <p className="relative min-w-0 truncate text-sm">
                <span className="font-medium">{status === 'rejected' ? 'Reactivation declined.' : status === 'requested' ? 'Reactivation requested.' : 'Sandbox archived after 30 days unused.'}</span>{' '}
                <span className="text-muted-foreground max-sm:hidden">
                    {status === 'rejected'
                        ? 'Contact us if you think this is a mistake.'
                        : keptUntil
                          ? `Your coworkers and their data are saved until ${formatKeptUntil(keptUntil, locale)}.`
                          : 'Its saved data has expired, a reactivation starts from an empty sandbox.'}
                </span>
            </p>
            {status !== 'rejected' && (
                <TooltipDisabledReason reason={status === 'requested' ? SANDBOX_REQUESTED_REASON : undefined} className="shrink-0 rounded-full">
                    <Button className="shrink-0 rounded-full px-3" disabled={status === 'requested'} onClick={onRequest}>
                        Request reactivation
                    </Button>
                </TooltipDisabledReason>
            )}
        </>
    )
}

// `approved`: a sandbox coming back on an approval rather than a payment, which changes what the
// two stalled states have to say.
function RestoringContent({ approved = false }: { approved?: boolean }) {
    const [stage, setStage] = useState<RestoreStage>('machine')
    const poll = useCallback(() => {
        getWorkspaceRestoreStageAction()
            .then(next => next && setStage(next))
            .catch(() => {})
    }, [])
    useVisibleInterval(poll, STAGE_POLL_MS)

    if (stage === 'waiting') {
        return (
            <div className="relative flex min-w-0 items-center gap-2 pr-3">
                <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 truncate text-sm">
                    <span className="font-medium">{approved ? "Reactivation approved, you're first in line." : "Payment received, you're first in line."}</span> <span className="text-muted-foreground max-sm:hidden">It comes back on its own within minutes.</span>
                </p>
            </div>
        )
    }

    // The teardown refuses this one every tick and never retries it: no "within minutes" here.
    if (stage === 'failed') {
        return (
            <div className="relative flex min-w-0 items-center gap-2 pr-3">
                <AlertCircleIcon className="size-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 truncate text-sm">
                    <span className="font-medium">Your restore needs a check on our side.</span> <span className="text-muted-foreground max-sm:hidden">{approved ? "We've been alerted and are bringing your sandbox back by hand." : "Payment received. We've been alerted and are bringing your workspace back by hand."}</span>
                </p>
            </div>
        )
    }

    const current = RESTORE_STEPS.findIndex(step => step.stage === stage)
    return (
        <div className="relative flex min-w-0 items-center gap-4 pr-3 pl-1">
            <Shimmer as="span" duration={1.6} className="text-sm font-medium whitespace-nowrap">
                Restoring your workspace…
            </Shimmer>
            <div className="flex items-center gap-3 max-md:hidden">
                {RESTORE_STEPS.map((step, index) => {
                    const done = index < current
                    const active = index === current
                    return (
                        <span key={step.stage} className={cn('flex items-center gap-1.5 text-xs whitespace-nowrap', done || active ? 'text-foreground' : 'text-muted-foreground')}>
                            {done ? <CircleCheckIcon className="size-3.5 text-emerald-500" /> : active ? <LoaderIcon className="size-3.5 animate-spin" /> : <span className="size-3.5 rounded-full border border-border" />}
                            {active ? (step.activeLabel ?? step.label) : step.label}
                        </span>
                    )
                })}
            </div>
        </div>
    )
}
