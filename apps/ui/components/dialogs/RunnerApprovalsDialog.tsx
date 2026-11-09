'use client'

import { listRunnerApprovalsAction, resolveRunnerApprovalAction } from '@/app/api/_actions/local-runner.actions'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { SkeletonList } from '@/components/ui/skeleton'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import type { RunnerPendingApproval } from '@/lib/engine/types'
import { ClockIcon, Loader2Icon, ShieldCheckIcon, TriangleAlertIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useIsWorkspaceAdmin } from '@/supabase/session/SessionProvider'
import { Badge, ScrollFade } from '@rerun/ui/primitives'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

const POLL_MS = 5_000

export const RUNNER_APPROVALS_ADMIN_ONLY = 'Only an admin can approve runner tasks'

function expiresLabel(expiresAt: string | undefined): string | null {
    if (!expiresAt) return null
    const date = new Date(expiresAt)
    if (Number.isNaN(date.getTime())) return null
    return `expires ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function RunnerApprovalsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [approvals, setApprovals] = useState<RunnerPendingApproval[]>([])
    const [errors, setErrors] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [busyId, setBusyId] = useState<string | null>(null)
    const adminReason = useIsWorkspaceAdmin() ? undefined : RUNNER_APPROVALS_ADMIN_ONLY

    const refresh = useCallback(async (initial = false) => {
        const result = await listRunnerApprovalsAction()
        if (result.ok) {
            setApprovals(result.approvals)
            setErrors(result.errors)
        } else if (initial) {
            toast.error(result.error)
        }
        setLoading(false)
    }, [])

    useEffect(() => {
        if (!open) return
        void refresh(true)
        const timer = setInterval(() => void refresh(), POLL_MS)
        return () => clearInterval(timer)
    }, [open, refresh])

    const resolve = async (approval: RunnerPendingApproval, decision: 'approve' | 'deny', scope?: 'always') => {
        if (busyId || adminReason) return
        setBusyId(approval.id)
        const result = await resolveRunnerApprovalAction({ id: approval.id, runner: approval.runnerId, decision, ...(scope ? { scope } : {}) })
        setBusyId(null)
        if (!result.ok) {
            toast.error(result.error)
            return
        }
        if (decision === 'deny') {
            toast.success('Denied — the runner refuses this task from now on')
        } else if (result.status === 'failed') {
            toast.error(result.error ?? 'The task failed')
        } else {
            toast.success(scope === 'always' ? 'Approved — this action is now always allowed' : 'Approved — the task ran')
        }
        void refresh()
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col sm:max-h-[85dvh] sm:max-w-lg sm:overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Runner approvals</DialogTitle>
                    <p className="text-sm text-muted-foreground">Tasks a local runner is holding until someone approves or denies them.</p>
                </DialogHeader>

                <ScrollFade className="-mx-1 min-h-0 flex-1 space-y-2 px-1 py-1">
                    {loading ? (
                        <SkeletonList rows={3} />
                    ) : approvals.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                            <ShieldCheckIcon className="size-6 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">Nothing is waiting for approval.</p>
                            <p className="text-xs text-muted-foreground/70">When an agent sends a task to a local runner in ask mode, it shows up here.</p>
                        </div>
                    ) : (
                        approvals.map(approval => {
                            const busy = busyId === approval.id
                            const expiry = expiresLabel(approval.expiresAt)
                            return (
                                <div key={approval.id} className={cn(PANEL_CARD, 'flex flex-col gap-2 p-3')}>
                                    <div className="flex items-center gap-2">
                                        <ShieldCheckIcon className="size-4 shrink-0 text-muted-foreground" />
                                        {approval.kind && (
                                            <Badge size="xs" tone="neutral" glow={false}>
                                                {approval.kind}
                                            </Badge>
                                        )}
                                        <span className="truncate text-xs text-muted-foreground">{approval.runnerName}</span>
                                        {expiry && (
                                            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                                                <ClockIcon className="size-3" />
                                                {expiry}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm break-words">{approval.approvalText ?? approval.taskKey ?? approval.id}</p>
                                    {approval.subject && <p className="text-xs text-muted-foreground">subject: {approval.subject}</p>}
                                    <TooltipDisabledReason reason={adminReason} className="w-full">
                                        <div className="flex flex-wrap gap-1.5">
                                            <Button size="sm" disabled={!!busyId || !!adminReason} onClick={() => void resolve(approval, 'approve')}>
                                                {busy && <Loader2Icon className="animate-spin" />}
                                                Approve
                                            </Button>
                                            <Button size="sm" variant="outline" disabled={!!busyId || !!adminReason} onClick={() => void resolve(approval, 'approve', 'always')}>
                                                Always allow
                                            </Button>
                                            <Button size="sm" variant="destructive" disabled={!!busyId || !!adminReason} onClick={() => void resolve(approval, 'deny')}>
                                                Deny
                                            </Button>
                                        </div>
                                    </TooltipDisabledReason>
                                </div>
                            )
                        })
                    )}
                    {errors.length > 0 && (
                        <p className="flex items-start gap-1.5 px-1 text-xs text-muted-foreground">
                            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                            <span>Some runners did not answer: {errors.join('; ')}</span>
                        </p>
                    )}
                </ScrollFade>
            </DialogContent>
        </Dialog>
    )
}
