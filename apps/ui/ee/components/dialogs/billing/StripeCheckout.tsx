'use client'

import { BillingAddressElement, CheckoutElementsProvider, PaymentElement, TaxIdElement, useCheckout } from '@stripe/react-stripe-js/checkout'
import type { Appearance } from '@stripe/stripe-js'
import { useTheme } from 'next-themes'
import { useState, type ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { stripeBrowser } from '@/ee/lib/billing/stripe-client'

import { Notice, PromoCodeField, usd } from './parts'

// No `verification` option: the element refuses to load with it on an account without Stripe Tax
// Complete. The number is still checked against VIES once it lands on the customer.
const TAX_ID_OPTIONS = { visibility: 'auto' } as const

function appearanceFor(theme: string | undefined): Appearance {
    return {
        theme: theme === 'light' ? 'stripe' : 'night',
        variables: { borderRadius: '8px', fontSizeBase: '14px', spacingUnit: '3px' },
    }
}

// A Checkout Session rendered by the app (`ui_mode: 'elements'`). Every child reads the session
// through `useCheckout`: its totals, `confirm`, `runServerUpdate`. The appearance is read once: the
// options of a mounted provider cannot change.
export function StripeCheckoutProvider({ clientSecret, children }: { clientSecret: string; children: ReactNode }) {
    const { resolvedTheme } = useTheme()
    const [options] = useState(() => ({ clientSecret, elementsOptions: { appearance: appearanceFor(resolvedTheme) } }))
    return (
        <CheckoutElementsProvider stripe={stripeBrowser()} options={options}>
            {children}
        </CheckoutElementsProvider>
    )
}

export function StripePaymentFieldsSkeleton() {
    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
            </div>
            <Skeleton className="h-10 w-full" />
            <div className="grid grid-cols-2 gap-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
            </div>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-5 w-48" />
        </div>
    )
}

// The card and the billing address. The address is not optional: the tax is computed from it.
// The tax ID sits behind Stripe's own "purchasing as a business" box: in this mode
// `tax_id_collection` on the session draws nothing by itself.
export function StripePaymentFields() {
    const checkout = useCheckout()
    if (checkout.type === 'loading') return <StripePaymentFieldsSkeleton />
    if (checkout.type === 'error') return <Notice tone="danger">{checkout.error.message}</Notice>

    return (
        <div className="flex flex-col gap-4">
            <PaymentElement options={{ layout: 'tabs' }} />
            <BillingAddressElement />
            <TaxIdElement options={TAX_ID_OPTIONS} />
        </div>
    )
}

// The session takes promotion codes, but in this mode Stripe draws no field for them. The discount
// reads off the next invoice when nothing is due today, which is every trial.
export function StripePromoCode({ disabled }: { disabled?: boolean }) {
    const checkout = useCheckout()
    if (checkout.type !== 'success') return null

    const session = checkout.checkout
    const discount = session.discountAmounts?.find(amount => amount.promotionCode)
    const discountCents = Math.max(discount?.minorUnitsAmount ?? 0, session.recurring?.dueNext.discount.minorUnitsAmount ?? 0)
    const applied = discount?.promotionCode
        ? { code: discount.promotionCode, discount: discount.percentOff != null ? `${discount.percentOff}% off` : `${usd(discountCents)} off` }
        : null

    return (
        <PromoCodeField
            applied={applied}
            disabled={disabled}
            onApply={async code => {
                const result = await session.applyPromotionCode(code)
                return result.type === 'error' ? result.error.message : null
            }}
            onRemove={async () => {
                const result = await session.removePromotionCode()
                return result.type === 'error' ? result.error.message : null
            }}
        />
    )
}
