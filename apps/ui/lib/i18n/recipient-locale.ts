import 'server-only'

import type { Database } from '@/app/api/database.types'
import { I18N_RELEASED } from '@/lib/features'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'
import { DEFAULT_LOCALE, isStableLocale, type Locale } from '@rerun/i18n'
import type { SupabaseClient } from '@supabase/supabase-js'

// The language a push, an email or a message sent to someone is written in, outside any request of
// theirs: the one their account picked, else their workspace's. An account can only pick one once
// the packs reach it, so before I18N_RELEASED only those accounts leave English.
export async function recipientLocale(supabase: SupabaseClient<Database>, userId: string, workspaceId: number | null): Promise<Locale> {
    const { data: user } = await selectMaybeSingle(supabase, 'users', ['locale'] as const, { id: userId })
    if (isStableLocale(user?.locale)) return user.locale
    if (!I18N_RELEASED || workspaceId === null) return DEFAULT_LOCALE
    const { data: workspace } = await selectMaybeSingle(supabase, 'workspaces', ['locale'] as const, { id: workspaceId })
    return isStableLocale(workspace?.locale) ? workspace.locale : DEFAULT_LOCALE
}
