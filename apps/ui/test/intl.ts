import { vi } from 'vitest'

// Components and server code read their strings through next-intl; under test they get the English
// source, so an assertion on visible text keeps reading English. A test that wants another language
// mocks next-intl itself.
vi.mock('next-intl', async () => {
    const { createTranslator } = await import('use-intl')
    const { ENGLISH_MESSAGES } = await import('@rerun/i18n/messages/en')
    const translator = (namespace?: string) => createTranslator({ locale: 'en', messages: ENGLISH_MESSAGES, namespace: namespace as never })
    return {
        useTranslations: (namespace?: string) => translator(namespace),
        useLocale: () => 'en',
        useNow: () => new Date(),
        useTimeZone: () => 'UTC',
        useMessages: () => ENGLISH_MESSAGES,
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

vi.mock('next-intl/server', async () => {
    const { createTranslator } = await import('use-intl')
    const { ENGLISH_MESSAGES } = await import('@rerun/i18n/messages/en')
    return {
        getTranslations: async (options?: string | { namespace?: string; locale?: string }) => {
            const namespace = typeof options === 'string' ? options : options?.namespace
            return createTranslator({ locale: 'en', messages: ENGLISH_MESSAGES, namespace: namespace as never })
        },
        getLocale: async () => 'en',
        getMessages: async () => ENGLISH_MESSAGES,
        getRequestConfig: (factory: unknown) => factory,
    }
})
