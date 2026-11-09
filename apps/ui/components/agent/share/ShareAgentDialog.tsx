'use client'

import * as React from 'react'
import { createAgentShareAction, planAgentShareAction } from '@/app/api/_actions/agent-share.actions'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Icon } from '@/components/ui/icon'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { useCanManageAgent } from '@/hooks/useBoxAccess'
import { BOX_MANAGE_REASON } from '@/lib/board/box-access'
import { formatBytes } from '@/lib/files/format'
import { Link2 } from '@/lib/icons'
import { Stripes } from '@rerun/ui/primitives'
import { useLocale } from 'next-intl'
import { ShareAgentLink } from './ShareAgentLink'
import { ShareAgentOptions, ShareAgentOptionsSkeleton } from './ShareAgentOptions'
import { ShareAgentSafety } from './ShareAgentSafety'
import { useShareAgentFlow, type ShareActions, type ShareFlow } from './useShareAgentFlow'

// Send an agent to someone, outside the marketplace. Two steps in one frame: what the copy carries,
// then the link. The archive is built when the link is created and never again, so what is agreed
// to here is exactly what the recipient gets, whatever the agent does afterwards.
export function ShareAgentDialog({ agentId, agentName, open, onOpenChange }: { agentId: string; agentName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* Same frame as the plan confirmation: the padding moves onto the rows so the striped
                header can run edge to edge. `p-0` also drops the sheet's safe-area padding, which
                the footer below puts back on its own.
                The body is mounted only while the dialog is open: its inspection streams an archive
                plan off the source box, and closing has to throw the answers away rather than leave
                them staged for the next agent. */}
            <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">{open && <ShareAgentBody agentId={agentId} agentName={agentName} onClose={() => onOpenChange(false)} />}</DialogContent>
        </Dialog>
    )
}

function ShareAgentBody({ agentId, agentName, onClose }: { agentId: string; agentName: string; onClose: () => void }) {
    const actions = React.useMemo<ShareActions>(
        () => ({
            plan: () => planAgentShareAction(agentId),
            create: include => createAgentShareAction({ agentId, include }),
        }),
        [agentId],
    )
    const flow = useShareAgentFlow(actions)

    return (
        <>
            {/* Stripes and the icon are painted behind the text, so both rows above it take
                `relative` rather than the whole block taking a stacking context. */}
            <div className="relative flex flex-col items-center gap-3 px-6 pt-8 pb-6 text-center">
                <Stripes />
                <Icon icon={Link2} className="relative" />
                <div className="relative flex flex-col gap-1.5">
                    <DialogTitle>{flow.step === 'link' ? 'Your share link' : `Share ${agentName}`}</DialogTitle>
                    <DialogDescription>
                        {flow.step === 'link'
                            ? 'Send it to whoever should have a copy. They do not need an account yet.'
                            : 'Pick what travels with the copy. Everything that makes it a coworker already does.'}
                    </DialogDescription>
                </div>
            </div>

            <div className="max-h-[55dvh] overflow-y-auto border-t border-border px-6 py-4">
                {flow.step === 'link' && flow.url ? (
                    <ShareAgentLink url={flow.url} reused={flow.reused} />
                ) : (
                    <div className="flex flex-col gap-4">
                        {flow.loading ? <ShareAgentOptionsSkeleton /> : flow.plan ? <ShareAgentOptions plan={flow.plan} include={flow.include} onChange={flow.setInclude} disabled={flow.busy} /> : null}

                        {flow.plan && flow.plan.warnings.length > 0 && (
                            <ul className="space-y-1.5">
                                {flow.plan.warnings.map(warning => (
                                    <li key={warning} className="text-xs text-muted-foreground">
                                        {warning}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <ShareAgentSafety />
                    </div>
                )}

                {flow.error && <p className="mt-4 text-xs text-destructive">{flow.error}</p>}
            </div>

            <DialogFooter className="m-0 px-6 py-4">
                {flow.step === 'link' ? (
                    <Button type="button" onClick={onClose}>
                        Done
                    </Button>
                ) : (
                    <>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <CreateLinkButton flow={flow} agentId={agentId} agentName={agentName} />
                    </>
                )}
            </DialogFooter>
        </>
    )
}

// Sending the agent alone needs no ceremony. Sending someone's memories, database or files out of
// the workspace does, and the confirmation spells out what that means rather than asking twice.
function CreateLinkButton({ flow, agentId, agentName }: { flow: ShareFlow; agentId: string; agentName: string }) {
    const locale = useLocale()
    const canManage = useCanManageAgent(agentId)
    const button = (
        <Button type="button" disabled={!canManage || flow.busy || flow.loading || !flow.plan} onClick={flow.carriesData ? undefined : () => void flow.create()}>
            {flow.busy ? 'Packing the coworker…' : 'Create link'}
        </Button>
    )
    if (!canManage) return <TooltipDisabledReason reason={BOX_MANAGE_REASON}>{button}</TooltipDisabledReason>
    if (!flow.carriesData || !flow.plan) return button

    const carried = [
        flow.include.memories && flow.plan.contents.memories.count > 0 ? `${flow.plan.contents.memories.count} memories` : null,
        flow.include.database && flow.plan.contents.database.count > 0 ? `its database (${formatBytes(flow.plan.contents.database.bytes, locale)}, not scanned for secrets)` : null,
        flow.include.files && flow.plan.contents.files.count > 0 ? `${flow.plan.contents.files.count} workspace files` : null,
    ].filter((entry): entry is string => entry !== null)

    // A switch turned on over an empty bucket carries nothing, so there is nothing to confirm.
    if (carried.length === 0) return button

    return (
        <ConfirmDialog
            title={`Send ${agentName} with its data?`}
            description={`The copy will carry ${carried.join(', ')}. Anyone holding the link can read all of it until you revoke it.`}
            confirmVariant="default"
            confirmLabel="Create link"
            pending={flow.busy}
            onConfirm={() => void flow.create()}
        >
            {button}
        </ConfirmDialog>
    )
}
