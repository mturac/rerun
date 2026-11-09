'use client'

import { createContext, useContext, type ReactNode } from 'react'

// The language the shared components format their dates and numbers in. The landing renders them
// without a provider and keeps English; the app hands its request locale down from the root layout.
const UiLocaleContext = createContext<string>('en')

export function UiLocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
    return <UiLocaleContext.Provider value={locale}>{children}</UiLocaleContext.Provider>
}

export function useUiLocale(): string {
    return useContext(UiLocaleContext)
}
