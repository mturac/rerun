'use server'

import { z } from 'zod'
import { assertSpaceAccess } from '@/app/api/_auth/access'
import { getAdminEmail } from '@/lib/auth/admin'
import { ARCHIVE_IMPORT_MAX_BYTES, ARCHIVE_IMPORT_MAX_MB, importedArchiveWarnings, STALE_IMPORT_HINT } from '@/lib/agents/capture-archive'
import { deriveUniqueHandle, importAgent } from '@/app/api/_services/agent.service'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'

const AGENT_NAME_MAX = 60

type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string }

function failed(err: unknown, fallback: string): { ok: false; error: string } {
    return { ok: false, error: err instanceof Error ? err.message : fallback }
}

export type ImportAgentArchiveResult = { agentId: string; agentName: string; inactive: boolean; warnings: string[] }

export async function importAgentArchiveAction(formData: FormData): Promise<ActionResult<ImportAgentArchiveResult>> {
    try {
        const archive = formData.get('archive')
        const name = String(formData.get('name') ?? '').trim().replace(/\s+/g, ' ')
        const spaceId = z.string().uuid().parse(String(formData.get('spaceId') ?? ''))

        if (!(archive instanceof File) || archive.size === 0) return { ok: false, error: 'Choose a .tar.gz archive to import.' }
        if (archive.size > ARCHIVE_IMPORT_MAX_BYTES) return { ok: false, error: `That archive is too large (max ${ARCHIVE_IMPORT_MAX_MB}MB).` }
        if (!name) return { ok: false, error: 'Name is required' }
        if (name.length > AGENT_NAME_MAX) return { ok: false, error: `Keep it under ${AGENT_NAME_MAX} characters` }

        const { actor } = await assertSpaceAccess(spaceId, 'manage')
        const workspace_id = actor.workspaceId
        const supabase = createServiceRoleClient()

        if ((await getAdminEmail()) === null) {
            const { data: workspace } = await selectMaybeSingle(supabase, 'workspaces', ['subscription_status'] as const, { id: workspace_id })
            const status = workspace?.subscription_status
            if (status !== 'active' && status !== 'trialing') throw new Error('This workspace has no active plan.')
        }

        const handle = await deriveUniqueHandle(supabase, workspace_id, name)
        let imported
        try {
            imported = await importAgent({ archive, name, handle, workspaceId: workspace_id, spaceId, actor })
        } catch (err) {
            if (err instanceof Error && /\/agents\/import failed: 404/.test(err.message)) throw new Error(STALE_IMPORT_HINT)
            throw err
        }

        return { ok: true, agentId: imported.agent.id, agentName: name, inactive: Boolean(imported.agent.disabled_at), warnings: importedArchiveWarnings(imported.imported) }
    } catch (err) {
        return failed(err, 'Could not import this coworker')
    }
}
