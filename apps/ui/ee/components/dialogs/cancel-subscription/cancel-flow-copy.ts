import { formatDate } from '@rerun/i18n/format'

import type { CancelComeback, CancelReason } from '@/ee/lib/billing/cancel-flow'

export const CANCEL_STEPS = ['goodbye', 'sunk', 'reason', 'offer', 'farewell', 'done'] as const
export type CancelStep = (typeof CANCEL_STEPS)[number]

export type CancelOutcome = 'cancelled' | 'claimed' | 'reminded'

export const OFFER_TITLE: Record<CancelReason, string> = {
    too_expensive: "We'd rather cut the price than lose you",
    unused: 'Give it another month',
    too_complex: 'Take another month to set it up',
    low_quality: 'Sorry it let you down',
    missing_features: 'We ship every week',
    switched_service: 'Before you switch',
    other: 'Before you go',
}

export const COMEBACK_COPY: readonly { value: CancelComeback; label: string }[] = [
    { value: 'coming_back', label: "I'll be back!" },
    { value: 'maybe', label: 'I might be back.' },
    { value: 'not_coming_back', label: 'Probably not.' },
]

export function shortDate(iso: string, locale: string): string {
    return formatDate(iso, locale, { month: 'short', day: 'numeric' })
}

export function daysBetween(fromIso: string, toIso: string): number {
    return Math.max(1, Math.ceil((Date.parse(toIso) - Date.parse(fromIso)) / (24 * 60 * 60_000)))
}
