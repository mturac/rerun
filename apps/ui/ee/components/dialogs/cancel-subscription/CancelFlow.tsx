'use client'

import type { CancelFlowState } from '@/ee/services/billing.service'
import type { CancelFlowActivity } from '@/ee/services/cancel-flow-activity.service'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { CANCEL_COMEBACKS, cancelReasonTextSchema, type CancelComeback, type CancelReason } from '@/ee/lib/billing/cancel-flow'
import { PLAN_CURRENCY } from '@/ee/lib/billing/plans'
import { fireRerunConfetti } from '@/lib/confetti'
import { ActivityIcon, BellIcon, CalendarIcon, CircleCheckIcon, CoinsIcon, HeartIcon, LockIcon, ShieldCheckIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { track } from '@rerun/analytics/client'
import { formatAmount } from '@rerun/contracts'
import { formatNumber } from '@rerun/i18n/format'
import { OptionRow } from '@rerun/ui/chat'
import { Icon } from '@rerun/ui/primitives'
import { TemplateBoardPreview, type BoardAgent } from '@rerun/ui/iso-grid'
import { StepTransition, useStepper } from '@rerun/ui/steps'
import { useLocale } from 'next-intl'
import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { CancelNote, DaysLeftCard, OfferCard, SunkCard, type IconType, type SunkStat } from './CancelFlowCards'
import { CancelTimeline, type CancelMilestone } from './CancelTimeline'
import { CANCEL_STEPS, COMEBACK_COPY, OFFER_TITLE, daysBetween, shortDate, type CancelOutcome, type CancelStep } from './cancel-flow-copy'

const reasonSchema = z.object({
    comment: cancelReasonTextSchema,
    comeback: z.enum(CANCEL_COMEBACKS),
})

type ReasonValues = z.infer<typeof reasonSchema>

// An answer that does not read as a reason is turned down this many times, then let through: the
// check is there to get a real answer, never to keep someone from cancelling.
const MAX_REASON_REFUSALS = 2

export type CancelInput = { comeback: CancelComeback; comment: string }

export type CancelReasonCheckResult = { genuine: boolean; reason: CancelReason }

export type CancelFlowProps = {
    state: CancelFlowState
    activity: CancelFlowActivity | null
    activityLoading: boolean
    agentCount: number
    creditLeftLabel: string
    // Each resolves to whether it went through; the flow only moves on when it did.
    onRemind: () => Promise<boolean>
    onClaim: () => Promise<boolean>
    onCancel: (input: CancelInput) => Promise<boolean>
    // null when the answer could not be read at all, which lets it through.
    onCheckReason: (text: string) => Promise<CancelReasonCheckResult | null>
    onResume: () => Promise<boolean>
    onClose: () => void
    onStepChange: (step: CancelStep) => void
}

type Header = { icon: IconType; title: string; description: string }

export function CancelFlow({ state, activity, activityLoading, agentCount, creditLeftLabel, onRemind, onClaim, onCancel, onCheckReason, onResume, onClose, onStepChange }: CancelFlowProps) {
    const locale = useLocale()
    const firstStep: CancelStep = state.reminderAt ? 'goodbye' : 'sunk'
    const stepper = useStepper(CANCEL_STEPS.length, CANCEL_STEPS.indexOf(firstStep))
    const step = CANCEL_STEPS[stepper.index]
    const [outcome, setOutcome] = useState<CancelOutcome>('cancelled')
    const [busy, setBusy] = useState(false)
    const [boardQuiet, setBoardQuiet] = useState(false)
    const [accepted, setAccepted] = useState<{ text: string; reason: CancelReason } | null>(null)
    const [refusals, setRefusals] = useState(0)

    const form = useForm<ReasonValues>({ resolver: zodResolver(reasonSchema), mode: 'onChange', defaultValues: { comment: '' } })
    const comment = useWatch({ control: form.control, name: 'comment' })
    const comeback = useWatch({ control: form.control, name: 'comeback' })
    const reason = accepted?.reason
    const reasonMissing = !comment.trim() ? 'Tell us in a few words why you are leaving' : !comeback ? "Tell us if you'll be back" : undefined

    const trial = state.phase === 'trial'
    const endsOn = shortDate(state.endsAt, locale)
    const keptUntil = shortDate(state.keptUntil, locale)
    const reminderOn = state.reminderAt ? shortDate(state.reminderAt, locale) : null
    const offer = state.offer
    const offerCopy = offer ? offerCopyOf(offer, endsOn, locale) : null

    useEffect(() => onStepChange(step), [step, onStepChange])

    useEffect(() => {
        if (step === 'offer' && offer && reason) track('retention_offer_shown', { phase: state.phase, reason, offer: offer.kind })
    }, [step, offer, reason, state.phase])

    const goTo = (target: CancelStep) => stepper.goTo(CANCEL_STEPS.indexOf(target))

    const finish = (next: CancelOutcome) => {
        setOutcome(next)
        goTo('done')
        if (next === 'claimed') void fireRerunConfetti()
    }

    const run = async (action: () => Promise<boolean>, next: CancelOutcome) => {
        if (busy) return
        setBusy(true)
        const ok = await action()
        setBusy(false)
        if (ok) finish(next)
    }

    const remind = () => run(onRemind, 'reminded')

    const claim = () =>
        run(async () => {
            const ok = await onClaim()
            if (ok && offer && reason) track('retention_offer_accepted', { phase: state.phase, reason, offer: offer.kind })
            return ok
        }, 'claimed')

    const declineOffer = () => {
        if (offer && reason) track('retention_offer_declined', { phase: state.phase, reason, offer: offer.kind })
        goTo('farewell')
    }

    const cancel = () => {
        const values = form.getValues()
        return run(() => onCancel({ comeback: values.comeback, comment: values.comment.trim() }), 'cancelled')
    }

    const resume = async () => {
        if (busy) return
        setBusy(true)
        const ok = await onResume()
        setBusy(false)
        if (ok) onClose()
    }

    const continueFromReason = form.handleSubmit(async values => {
        if (busy) return
        const text = values.comment.trim()
        if (accepted?.text !== text) {
            setBusy(true)
            const check = await onCheckReason(text)
            setBusy(false)
            if (check && !check.genuine && refusals < MAX_REASON_REFUSALS) {
                setRefusals(count => count + 1)
                form.setError('comment', { message: "That doesn't read like a reason. What made you decide to leave?" })
                return
            }
            setAccepted({ text, reason: check?.genuine ? check.reason : 'other' })
        }
        goTo(offer ? 'offer' : 'farewell')
    })

    const goBack = () => {
        if (step === firstStep) return onClose()
        if (step === 'farewell' && !offer) return goTo('reason')
        stepper.back()
    }

    const header = ((): Header => {
        if (step === 'goodbye') {
            return trial
                ? { icon: BellIcon, title: `Not sure yet? Decide on ${reminderOn}`, description: "Keep your trial running. We'll email you the day before your first charge." }
                : { icon: BellIcon, title: `Not sure yet? Decide on ${reminderOn}`, description: "Keep your coworkers running. We'll email you a week before you're charged, so you can still cancel then." }
        }
        if (step === 'sunk') {
            return trial
                ? { icon: LockIcon, title: 'Your coworkers are already set up', description: 'The hard part is done. Leave now and they stop working with it.' }
                : { icon: LockIcon, title: "You've already paid for this", description: `It's yours until ${endsOn} either way. The credits you don't use go with it.` }
        }
        if (step === 'reason') return { icon: HeartIcon, title: 'Why are you leaving?', description: 'In your own words. It tells us what to fix first.' }
        if (step === 'offer') return { icon: HeartIcon, title: OFFER_TITLE[reason ?? 'other'], description: 'Your plan and your coworkers stay exactly as they are.' }
        if (step === 'farewell') {
            return { icon: LockIcon, title: `Your coworkers will go quiet on ${endsOn}`, description: 'Schedules stop firing and your workspace is paused.' }
        }
        if (outcome === 'claimed') return { icon: CircleCheckIcon, title: 'Thanks for staying', description: 'Your coworkers never stopped working.' }
        if (outcome === 'reminded') return { icon: BellIcon, title: `We'll remind you on ${reminderOn}`, description: 'Nothing changes until then. Your coworkers keep working.' }
        return { icon: CircleCheckIcon, title: 'Cancellation confirmed', description: `You won't be billed again. Your coworkers work until ${endsOn}.` }
    })()

    const milestones = useMemo((): CancelMilestone[] => {
        if (!state.reminderAt) return []
        const now = Date.parse(state.now)
        const end = Date.parse(state.endsAt)
        return [
            { at: 0, label: 'You stay', date: new Date(now) },
            { at: (Date.parse(state.reminderAt) - now) / (end - now), label: trial ? 'Email' : 'Reminder', date: new Date(state.reminderAt), highlighted: true },
            { at: 1, label: trial ? 'First charge' : 'Renewal', date: new Date(end) },
        ]
    }, [state.now, state.reminderAt, state.endsAt, trial])

    const boardAgents = useMemo((): BoardAgent[] => (activity?.agents ?? []).map(({ key, name, connectorSlugs }) => ({ key, name, connectorSlugs })), [activity])

    const sunk = sunkFigures({ trial, state, activity, agentCount, creditLeftLabel, locale })
    const contentKey = `${step}-${outcome}`

    return (
        <div className="flex min-h-0 flex-col">
            <div className="px-6 pt-6 pb-6">
                <DialogHeader className="mb-5 gap-0">
                    <StepTransition stepKey={contentKey} direction={stepper.direction} variant="header" className="flex flex-col gap-1.5 pr-6">
                        <Icon icon={header.icon} size="sm" className="mb-2" />
                        <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight text-balance">{header.title}</DialogTitle>
                        <DialogDescription>{header.description}</DialogDescription>
                    </StepTransition>
                </DialogHeader>

                <StepTransition stepKey={contentKey} direction={stepper.direction}>
                    {step === 'goodbye' && (
                        <div className="flex flex-col gap-5">
                            <DaysLeftCard trial={trial} daysLeft={daysBetween(state.now, state.endsAt)} agents={activity?.agents ?? []} loading={activityLoading} />
                            <CancelTimeline milestones={milestones} />
                            <Button size="lg" highlight className="w-full" disabled={busy} onClick={remind}>
                                <BellIcon />
                                Remind me on {reminderOn}
                            </Button>
                        </div>
                    )}
                    {step === 'sunk' && (
                        <div className="flex flex-col gap-5">
                            <SunkCard value={sunk.value} caption={sunk.caption} stats={sunk.stats} loading={activityLoading} />
                            <Button size="lg" highlight className="w-full" onClick={onClose}>
                                Keep my coworkers running
                            </Button>
                        </div>
                    )}
                    {step === 'reason' && (
                        <Form {...form}>
                            <form onSubmit={continueFromReason} className="flex flex-col gap-5">
                                <FormField
                                    control={form.control}
                                    name="comment"
                                    render={({ field }) => (
                                        <FormItem>
                                            <Field label="What made you decide to leave?">
                                                <FormControl>
                                                    <Textarea rows={4} placeholder="A sentence is plenty" disabled={busy} {...field} />
                                                </FormControl>
                                            </Field>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <Field label="Will you use Rerun again?">
                                    <div className="-mx-2 space-y-0.5">
                                        {COMEBACK_COPY.map((option, index) => (
                                            <OptionRow key={option.value} index={index} label={option.label} selected={comeback === option.value} onChoose={() => form.setValue('comeback', option.value, { shouldValidate: true })} />
                                        ))}
                                    </div>
                                </Field>
                            </form>
                        </Form>
                    )}
                    {step === 'offer' && offer && offerCopy && (
                        <div className="flex flex-col gap-5">
                            <OfferCard headline={offerCopy.headline} priceLabel={offerCopy.priceLabel} fullPriceLabel={offerCopy.fullPriceLabel} billedOnLabel={shortDate(offer.billedOn, locale)} terms={offerCopy.terms} />
                            <Button size="lg" highlight className="w-full" disabled={busy} onClick={claim}>
                                {offerCopy.claimLabel}
                            </Button>
                        </div>
                    )}
                    {step === 'farewell' && (
                        <div className="flex flex-col gap-4">
                            {activityLoading ? (
                                <Skeleton className="h-44 rounded-xl" />
                            ) : (
                                boardAgents.length > 0 && (
                                    <div className={cn('relative h-44 overflow-hidden rounded-xl bg-muted/40 transition-[filter,opacity] duration-700', boardQuiet && 'opacity-35 grayscale')}>
                                        <TemplateBoardPreview agents={boardAgents} connectors={activity?.connectors ?? []} alive={!boardQuiet} maxZoom={3} className="size-full" />
                                    </div>
                                )
                            )}
                            <CancelNote icon={ShieldCheckIcon} title={`Saved until ${keptUntil}`} description="Memories, files and skills are kept. Subscribe again before then and it all comes back." />
                            <Button size="lg" highlight className="w-full" onClick={onClose}>
                                Keep my coworkers
                            </Button>
                        </div>
                    )}
                    {step === 'done' && <DoneBody trial={trial} outcome={outcome} endsOn={endsOn} keptUntil={keptUntil} reminderOn={reminderOn} claimedDescription={offerCopy?.claimedDescription ?? null} claimedTitle={offerCopy?.headline ?? null} />}
                </StepTransition>
            </div>

            <DialogFooter className={cn('m-0 px-6 py-4', step !== 'done' && 'sm:justify-between')}>
                {step === 'done' ? (
                    <>
                        {outcome === 'cancelled' && (
                            <Button variant="outline" disabled={busy} onClick={resume}>
                                {trial ? 'Resume trial' : 'Resume subscription'}
                            </Button>
                        )}
                        <Button onClick={onClose}>Done</Button>
                    </>
                ) : (
                    <>
                        <Button variant="ghost" disabled={busy} onClick={goBack}>
                            Go back
                        </Button>
                        {step === 'goodbye' && (
                            <Button variant="outline" disabled={busy} onClick={stepper.goForward}>
                                Continue to cancel
                            </Button>
                        )}
                        {step === 'sunk' && (
                            <Button variant="outline" onClick={stepper.goForward}>
                                Continue
                            </Button>
                        )}
                        {step === 'reason' && (
                            <TooltipDisabledReason reason={reasonMissing}>
                                <Button variant="outline" disabled={!!reasonMissing || busy} onClick={() => void continueFromReason()}>
                                    Continue
                                </Button>
                            </TooltipDisabledReason>
                        )}
                        {step === 'offer' && (
                            <Button variant="outline" disabled={busy} onClick={declineOffer}>
                                No thanks
                            </Button>
                        )}
                        {step === 'farewell' && (
                            <Button
                                variant="destructive"
                                disabled={busy}
                                onMouseEnter={() => setBoardQuiet(true)}
                                onMouseLeave={() => setBoardQuiet(false)}
                                onFocus={() => setBoardQuiet(true)}
                                onBlur={() => setBoardQuiet(false)}
                                onClick={() => void cancel()}
                            >
                                {trial ? 'Cancel trial' : 'Cancel subscription'}
                            </Button>
                        )}
                    </>
                )}
            </DialogFooter>
        </div>
    )
}

type OfferCopy = { headline: string; priceLabel: string; fullPriceLabel: string; terms: string; claimLabel: string; claimedDescription: string }

function offerCopyOf(offer: NonNullable<CancelFlowState['offer']>, endsOn: string, locale: string): OfferCopy {
    const price = formatAmount(offer.priceCents, PLAN_CURRENCY)
    const full = formatAmount(offer.fullPriceCents, PLAN_CURRENCY)
    const fullFrom = shortDate(offer.fullPriceFrom, locale)

    if (offer.kind === 'trial_half') {
        return {
            headline: '50% off your first month',
            priceLabel: price,
            fullPriceLabel: full,
            terms: `Then ${full}/mo from ${fullFrom}. We email you before ${endsOn}, and you can still cancel for free until then.`,
            claimLabel: 'Claim 50% off',
            claimedDescription: `Your first invoice is ${price} on ${endsOn}, then ${full}/mo.`,
        }
    }

    // The $1 is the base plan's price: with add-ons the card shows the base plan against its list
    // price, and the add-ons, billed as usual, are spelled out underneath.
    const addonsCents = offer.fullPriceCents - offer.basePriceCents
    return {
        headline: 'Next month for $1',
        priceLabel: formatAmount(offer.priceCents - addonsCents, PLAN_CURRENCY),
        fullPriceLabel: formatAmount(offer.basePriceCents, PLAN_CURRENCY),
        terms: addonsCents > 0 ? `Your add-ons stay at ${formatAmount(addonsCents, PLAN_CURRENCY)}/mo. Then ${full}/mo from ${fullFrom}.` : `Then ${full}/mo from ${fullFrom}.`,
        claimLabel: 'Get next month for $1',
        claimedDescription: `Your next invoice is ${price}. Billing goes back to ${full}/mo on ${fullFrom}.`,
    }
}

function sunkFigures({ trial, state, activity, agentCount, creditLeftLabel, locale }: { trial: boolean; state: CancelFlowState; activity: CancelFlowActivity | null; agentCount: number; creditLeftLabel: string; locale: string }): {
    value: string
    caption: string
    stats: SunkStat[]
} {
    const runs = activity ? formatNumber(activity.runsMonth, locale) : null

    if (!trial) {
        return {
            value: formatAmount(state.paidLeftCents, PLAN_CURRENCY),
            caption: 'of this month, already paid',
            stats: [
                { icon: CoinsIcon, label: 'Credits left', value: creditLeftLabel },
                { icon: ActivityIcon, label: 'Runs this month', value: runs },
            ],
        }
    }

    return {
        value: agentCount > 0 ? `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}` : creditLeftLabel,
        caption: agentCount > 0 ? 'set up, connected and working' : 'Rerun credits left',
        stats: [
            { icon: ActivityIcon, label: 'Runs so far', value: runs },
            { icon: CalendarIcon, label: 'Schedules', value: activity ? formatNumber(activity.schedules, locale) : null },
        ],
    }
}

function DoneBody({
    trial,
    outcome,
    endsOn,
    keptUntil,
    reminderOn,
    claimedTitle,
    claimedDescription,
}: {
    trial: boolean
    outcome: CancelOutcome
    endsOn: string
    keptUntil: string
    reminderOn: string | null
    claimedTitle: string | null
    claimedDescription: string | null
}) {
    if (outcome === 'reminded') {
        return <CancelNote icon={BellIcon} title={`Email on ${reminderOn}`} description={trial ? 'The day before your first charge. Cancel from that email if you want to.' : `A week before your plan renews on ${endsOn}.`} />
    }

    if (outcome === 'claimed' && claimedTitle && claimedDescription) return <CancelNote icon={CircleCheckIcon} title={claimedTitle} description={claimedDescription} />

    return (
        <div className="flex flex-col gap-3">
            <CancelNote icon={CalendarIcon} title={`Active until ${endsOn}`} description={trial ? 'Your trial runs to its end. Nothing is charged.' : 'Everything keeps working until then.'} />
            <CancelNote icon={ShieldCheckIcon} title="Changed your mind?" description={`Resume before ${endsOn} and nothing stops. After that, your workspace is saved until ${keptUntil}.`} />
        </div>
    )
}
