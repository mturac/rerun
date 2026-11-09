import { requestLocale, requestTimeZone } from '@/lib/i18n/request-locale'
import { cloudMessages } from '@rerun/cloud/messages'
import { loadMessages } from '@rerun/i18n/messages'
import { getRequestConfig } from 'next-intl/server'

export default getRequestConfig(async () => {
    const locale = await requestLocale()
    const [messages, timeZone] = await Promise.all([cloudMessages(locale).then(extra => loadMessages(locale, [extra])), requestTimeZone()])
    return { locale, messages, timeZone }
})
