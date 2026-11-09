'use client'

import { ExplainerCheck } from '@/components/dialogs/ExplainerPanel'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { PROVIDER_PITCH, type AddableProvider } from '@/lib/engine/ai-sources'
import { useTranslations } from 'next-intl'

import { OfferFooter } from './offer-footer'
import { PLANS, PROVIDER_GLYPH } from './offer-plans'

type ConnectedTranslator = ReturnType<typeof useTranslations<'dialogs.subscriptionOffer'>>

function connectedCopy(provider: AddableProvider, t: ConnectedTranslator) {
    if (provider === 'claude' || provider === 'codex') {
        const { name } = PLANS[provider]
        return { title: t('connected.title', { name }), detail: t('connected.planDetail', { name }) }
    }
    if (provider === 'opencode') return { title: t('connected.title', { name: 'OpenCode' }), detail: t('connected.opencodeDetail') }
    return { title: t('connected.title', { name: PROVIDER_PITCH[provider].title }), detail: t('connected.keyDetail') }
}

export function ConnectedStep({ provider, onDone }: { provider: AddableProvider; onDone: () => void }) {
    const t = useTranslations('dialogs.subscriptionOffer')
    const { title, detail } = connectedCopy(provider, t)

    return (
        <>
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
                <span className="relative">
                    <Icon size="lg" icon={PROVIDER_GLYPH[provider]} />
                    <span className="absolute -right-2 -bottom-2 z-20">
                        <ExplainerCheck />
                    </span>
                </span>
                <div>
                    <h2 className="text-base font-medium">{title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
                </div>
            </div>

            <OfferFooter>
                <Button onClick={onDone}>{t('connected.done')}</Button>
            </OfferFooter>
        </>
    )
}
