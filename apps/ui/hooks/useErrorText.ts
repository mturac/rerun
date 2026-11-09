'use client'

import type { ActionFailure } from '@/lib/i18n/action-error'
import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

// What a refused action says on screen: its code in the reader's language, or the server's English
// text for a refusal that has no code yet.
export function useErrorText() {
    const t = useTranslations('errors')
    return useCallback((failure: Pick<ActionFailure, 'error' | 'code' | 'params'>) => (failure.code ? t(failure.code, failure.params as never) : failure.error), [t])
}
