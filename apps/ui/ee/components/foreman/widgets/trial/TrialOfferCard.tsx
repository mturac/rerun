'use client'

import { BorderBeam } from '@rerun/ui'
import { useLocale } from 'next-intl'
import { Badge } from '@rerun/ui/primitives'

import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { PLAN_CURRENCY, TRIAL_DAYS, basePriceCents, cardlessTrialLine, trialChargeLine, trialEndDate, trialLimitsLabel, type PriceArm } from '@/ee/lib/billing/plans'
import type { TrialOffer } from '@/ee/lib/billing/checkout-variant'
import { shortDate } from '@/ee/lib/billing/dates'
import { CalendarClockIcon, CircleCheckIcon, CreditCardIcon, type LucideIcon } from '@/lib/icons'
import { TRIAL_ENDING_LEAD_MS } from '@/ee/lib/lifecycle/sequences'
import { formatAmount } from '@rerun/contracts'

// The trial, sold where it is asked for. On the cardless arm of the trial test the button starts it on
// the spot, so the card has to say out loud that something starts the moment they press it. On the
// card arm it opens the card form, and a workspace whose trial is spent gets the same card billed
// today.

type TrialOfferCardProps = {
    offer: TrialOffer
    priceArm: PriceArm
    submitting: boolean
    error?: string | null
    onStart: () => void
    // What the trial puts to work, when it is not a team the assistant designed: the template or the
    // shared coworker they arrived on, named so the card sells that and not a plan.
    subject?: string
    // A paid template is bought right after the trial starts, and the card says so before the click.
    thenPay?: string
}

const OFFER_BADGE: Record<TrialOffer, string> = {
    cardless: 'No card needed',
    card_trial: `${TRIAL_DAYS}-day free trial`,
    paid: 'Free trial already used',
}

function offerPitch(offer: TrialOffer, price: string, chargeDate: string, subject?: string): string {
    const next = subject ? `${subject} is installed right after.` : 'Your team is built right after.'
    if (offer === 'paid') return `${next} Cancel anytime from the workspace.`
    const line = offer === 'cardless' ? cardlessTrialLine : trialChargeLine
    return `${line(price, chargeDate)} ${next}`
}

function TimelineStep({ icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
    return (
        <li className="relative flex gap-3 pb-3 last:pb-0">
            {/* Opaque behind the icon's translucent tile, so the rail stops at its edge. */}
            <span className="relative z-10 shrink-0 rounded-lg bg-background">
                <Icon icon={icon} size="sm" className="text-muted-foreground" />
            </span>
            <div className="min-w-0 pt-1">
                <p className="text-sm font-medium leading-tight text-foreground">{title}</p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
            </div>
        </li>
    )
}

export function TrialOfferCard({ offer, priceArm, submitting, error, onStart, subject, thenPay }: TrialOfferCardProps) {
    const locale = useLocale()
    const price = formatAmount(basePriceCents(priceArm), PLAN_CURRENCY)
    const trial = offer !== 'paid'
    const cardless = offer === 'cardless'
    const chargeOn = trialEndDate()
    const chargeDate = shortDate(chargeOn, locale)
    const reminderDate = shortDate(new Date(chargeOn.getTime() - TRIAL_ENDING_LEAD_MS), locale)

    return (
        <div className="relative mb-2 rounded-xl border border-border bg-background">
            <BorderBeam animated pattern="arcs" tone="brand" duration={8} outset={1} />

            <div className="relative flex flex-col gap-5 p-4">
                <div className="flex flex-col gap-2">
                    <Badge size="xs" className="self-start">
                        {OFFER_BADGE[offer]}
                    </Badge>
                    <h3 className="text-lg font-semibold tracking-tight text-foreground">{trial ? `Start your ${TRIAL_DAYS}-day free trial` : 'Start your plan'}</h3>
                    <p className="text-sm text-muted-foreground">{offerPitch(offer, price, chargeDate, subject)}</p>
                    {trial && <p className="text-xs text-muted-foreground">{`Your trial includes ${trialLimitsLabel()}.`}</p>}
                    {thenPay && <p className="text-xs text-muted-foreground">{`Then ${thenPay} for this template, billed separately.`}</p>}
                </div>

                <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-xs text-muted-foreground">Due today</dt>
                        <dd className="text-2xl font-semibold leading-none text-foreground">{trial ? formatAmount(0, PLAN_CURRENCY) : price}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-xs text-muted-foreground">{cardless ? 'With a card' : trial ? `On ${chargeDate}` : 'Then'}</dt>
                        <dd className="text-base font-semibold text-foreground">
                            {price}
                            <span className="text-xs font-normal text-muted-foreground">/month</span>
                        </dd>
                    </div>
                </dl>

                {trial ? (
                    <ol className="relative before:absolute before:bottom-4 before:left-4 before:top-4 before:w-px before:bg-border">
                        <TimelineStep icon={CircleCheckIcon} title="Today" description={subject ? `Your trial starts and ${subject} is installed.` : 'Your trial starts and your team is built.'} />
                        <TimelineStep icon={CalendarClockIcon} title={reminderDate} description="We email you, so it never ends by surprise." />
                        <TimelineStep
                            icon={CreditCardIcon}
                            title={chargeDate}
                            description={
                                cardless
                                    ? `Add a card to keep going at ${price}/month. Without one, your coworkers stop and nothing is charged.`
                                    : `${price} charged to the card you added, then every month. Cancel before and nothing is charged.`
                            }
                        />
                    </ol>
                ) : null}

                <div className="flex flex-col gap-2">
                    {error ? <p className="text-sm text-destructive">{error}</p> : null}
                    <Button size="lg" className="h-11 w-full rounded-xl text-base" onClick={onStart} disabled={submitting}>
                        {submitting ? (cardless ? 'Starting your trial…' : 'Opening…') : trial ? (subject ? 'Start my trial and install' : 'Start my free trial') : 'Start my plan'}
                    </Button>
                </div>
            </div>
        </div>
    )
}
