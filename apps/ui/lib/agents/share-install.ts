import type { SupabaseClient } from '@supabase/supabase-js'
import type { Actor } from '@/app/api/_auth/access'
import type { Database } from '@/app/api/database.types'
import { deriveUniqueHandle, importAgent } from '@/app/api/_services/agent.service'
import { downloadPrivateFile } from '@/lib/storage/private'
import { selectMaybeSingle } from '@/supabase/supabase-helpers'
import { isOpaqueToken } from '@/lib/opaque-token'
import type { GridPosition } from '@/lib/board/types'
import { importedArchiveWarnings, STALE_IMPORT_HINT } from './capture-archive'
import { AGENT_SHARE_BUCKET, AGENT_SHARE_TOKEN_LENGTH } from './share-create'

// The mirror of `installTemplate`, for a link that carries exactly one agent. Nothing here opens
// the tarball: the engine is the only side that does, so the connectors the copy still needs are
// the ones its own registry already declares as needing auth.

const DEAD_LINK = 'This share link is no longer available.'

export type AgentShareInstallOutcome = { agentId: string; agentName: string; inactive: boolean; warnings: string[] }

export async function installAgentShare(
    supabase: SupabaseClient<Database>,
    token: string,
    target: { workspaceId: number; spaceId: string; actor: Actor; position?: GridPosition },
): Promise<AgentShareInstallOutcome> {
    if (!isOpaqueToken(token, AGENT_SHARE_TOKEN_LENGTH)) throw new Error(DEAD_LINK)

    const { data: share } = await selectMaybeSingle(supabase, 'agent_shares', ['id', 'archive_path', 'source_agent_name', 'install_count', 'revoked_at'] as const, { token })
    // Revoked, swept, or never real: one message for all three, so the link cannot be used to
    // confirm that something once existed here.
    if (!share || share.revoked_at || !share.archive_path) throw new Error(DEAD_LINK)

    const name = share.source_agent_name
    const handle = await deriveUniqueHandle(supabase, target.workspaceId, name)
    const blob = await downloadPrivateFile(supabase, AGENT_SHARE_BUCKET, share.archive_path)

    let imported
    try {
        imported = await importAgent({ archive: blob, name, handle, workspaceId: target.workspaceId, spaceId: target.spaceId, actor: target.actor, position: target.position })
    } catch (err) {
        if (err instanceof Error && /\/agents\/import failed: 404/.test(err.message)) throw new Error(STALE_IMPORT_HINT)
        throw err
    }

    // Informational only, and deliberately not a gate: the link has no install quota, so a lost
    // race here costs a wrong number on a panel, never a refused install.
    await supabase
        .from('agent_shares')
        .update<Database['public']['Tables']['agent_shares']['Update']>({ install_count: share.install_count + 1 })
        .eq('id', share.id)

    const warnings = importedArchiveWarnings(imported.imported)

    return { agentId: imported.agent.id, agentName: name, inactive: Boolean(imported.agent.disabled_at), warnings }
}
