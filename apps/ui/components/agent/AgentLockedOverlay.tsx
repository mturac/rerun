'use client'

import { activateAgentAction } from '@/app/api/_actions/agent.actions'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { formatKeptUntil } from '@/components/layout/WorkspacePausedBanner'
import { useCanManageAgent } from '@/hooks/useBoxAccess'
import { useEntitlements } from '@/hooks/useEntitlements'
import { BOX_MANAGE_REASON } from '@/lib/board/box-access'
import { useWorkspaceAccess } from '@/hooks/useWorkspaceAccess'
import { LoaderIcon, LockIcon } from '@/lib/icons'
import { isPlanLimited, type IsoAgent } from '@/lib/board/types'
import { useBillingStore } from '@/stores/billing.store'
import { useBoardStore } from '@/stores/board.store'
import { useSession } from '@/supabase/session/SessionProvider'
import { useLocale } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'

// What a switched-off agent shows instead of its tabs. There is no matching "deactivate": the plan
// says how many agents run, the user says which ones, and freeing a slot means deleting an agent
// (Settings stays reachable behind this, which is where that lives).
export function AgentLockedOverlay({ agent }: { agent: IsoAgent }) {
    const { access, keptUntil, paymentFailed, sandboxArchived } = useWorkspaceAccess()
    if (sandboxArchived) return <SandboxArchivedOverlay name={agent.name} keptUntil={keptUntil} />
    if (access === 'paused') return <WorkspacePausedOverlay name={agent.name} keptUntil={keptUntil} paymentFailed={paymentFailed} />
    if (access === 'restoring') return <WorkspaceRestoringOverlay name={agent.name} />
    return <AgentSlotOverlay agent={agent} />
}

// The whole workspace is off, its machine archived: nothing here is about a slot.
export function WorkspacePausedOverlay({ name, keptUntil, paymentFailed = false }: { name: string; keptUntil: Date | null; paymentFailed?: boolean }) {
    const locale = useLocale()
    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            <Icon size="lg" icon={LockIcon} className="text-muted-foreground" />
            <div className="space-y-1.5">
                <p className="text-sm font-medium">{name} is paused with your workspace</p>
                <p className="text-sm text-muted-foreground">
                    Its conversations, memory, skills, schedules and files are saved{keptUntil ? ` until ${formatKeptUntil(keptUntil, locale)}` : ''}. {paymentFailed ? 'Update your payment' : 'Subscribe'} and {name} picks up exactly where it stopped.
                </p>
            </div>
            <Button variant="outline" highlight onClick={() => useBillingStore.getState().openBilling(undefined, 'paused_agent_panel')}>
                {paymentFailed ? 'Update payment' : 'Subscribe to restore'}
            </Button>
        </div>
    )
}

// No button here: the request lives on the board's banner, where its answer is shown too.
function SandboxArchivedOverlay({ name, keptUntil }: { name: string; keptUntil: Date | null }) {
    const locale = useLocale()
    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            <Icon size="lg" icon={LockIcon} className="text-muted-foreground" />
            <div className="space-y-1.5">
                <p className="text-sm font-medium">{name} is archived with your sandbox</p>
                <p className="text-sm text-muted-foreground">
                    Its conversations, memory, skills, schedules and files are saved{keptUntil ? ` until ${formatKeptUntil(keptUntil, locale)}` : ''}. Request a reactivation from the board and {name} picks up exactly where it stopped.
                </p>
            </div>
        </div>
    )
}

export function WorkspaceRestoringOverlay({ name }: { name: string }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            <Icon size="lg" icon={LoaderIcon} className="text-muted-foreground [&_svg]:animate-spin" />
            <div className="space-y-1.5">
                <p className="text-sm font-medium">{name} is on its way back</p>
                <p className="text-sm text-muted-foreground">Your workspace is being restored. {name} wakes up with it in a minute or two.</p>
            </div>
        </div>
    )
}

// Only a trial's cap is lifted by paying: a paid plan runs unlimited coworkers, so a number left on
// a subscribed workspace was set by hand from the admin and no checkout raises it.
const FIXED_LIMIT_REASON = 'This workspace has a fixed coworker limit. Contact support to raise it.'

function AgentSlotOverlay({ agent }: { agent: IsoAgent }) {
    const { noFreeAgentSlot, activeAgentsCount, maxAgents, gate } = useEntitlements()
    const { workspace } = useSession()
    const localActivateAgent = useBoardStore(s => s._localActivateAgent)
    const canManage = useCanManageAgent(agent.id)
    const [activating, setActivating] = useState(false)

    const fromTemplate = !isPlanLimited(agent)
    const capFixedByHand = noFreeAgentSlot && workspace?.subscription_status !== 'trialing'

    const handleActivate = async () => {
        setActivating(true)
        const res = await activateAgentAction(agent.id)
        setActivating(false)
        if (!res.ok) {
            toast.error('Could not activate this coworker', { description: res.error })
            return
        }
        localActivateAgent(agent.id)
        toast.success(`${agent.name} is back online`)
    }

    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            <Icon size="lg" icon={LockIcon} className="text-muted-foreground" />
            <div className="space-y-1.5">
                <p className="text-sm font-medium">{agent.name} is inactive</p>
                <p className="text-sm text-muted-foreground">
                    {fromTemplate
                        ? 'The template subscription this coworker came from has ended. Buy the template again to bring it back.'
                        : 'Nothing has been lost: its memories, files and skills are all still here. It just needs a free coworker slot to run again.'}
                </p>
            </div>

            {!fromTemplate &&
                (noFreeAgentSlot ? (
                    <div className="space-y-2">
                        <TooltipDisabledReason reason={capFixedByHand ? FIXED_LIMIT_REASON : undefined}>
                            <Button variant="outline" highlight disabled={capFixedByHand} onClick={gate}>
                                Upgrade to activate
                            </Button>
                        </TooltipDisabledReason>
                        {maxAgents !== null && (
                            <p className="text-xs text-muted-foreground">
                                {activeAgentsCount} of {maxAgents} coworkers active
                            </p>
                        )}
                    </div>
                ) : (
                    <TooltipDisabledReason reason={canManage ? undefined : BOX_MANAGE_REASON}>
                        <Button size="sm" disabled={activating || !canManage} onClick={handleActivate}>
                            {activating ? 'Activating…' : 'Activate'}
                        </Button>
                    </TooltipDisabledReason>
                ))}
        </div>
    )
}
