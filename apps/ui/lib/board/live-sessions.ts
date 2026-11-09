import { sessionObservationOf } from './session-execution'
import type { Database } from '@/app/api/database.types'
import type { SessionEntry, SessionStatus } from '@/lib/board/types'
import { selectMany } from '@/supabase/supabase-helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

type Client = SupabaseClient<Database>

const STALE_THRESHOLD_MS = 5 * 60 * 1000
// Bounds the batch handed to the engine, so a board full of long-running agents does not turn one
// load into a sweep of every session. The rest are swept on a later load.
const STALE_CHECK_LIMIT = 10

// A session missing from the store scores exactly like an idle one, and loading the idle ones used
// to cost the board its live ones: PostgREST caps a response at 1000 rows, and a workspace with
// thousands of finished sessions pushed the ones that carry a status out of the cap. Newest first,
// truncated below the cap so what falls off the end is always the oldest. null = query failed.
export async function fetchLiveSessions(supabase: Client, agentIds: string[]): Promise<SessionEntry[] | null> {
    const { data } = await selectMany(supabase, 'sessions', ['id', 'agent_id', 'origin_agent_id', 'status', 'engine_run_id', 'execution_revision', 'execution_projection_version', 'execution_attention_revision', 'updated_at'] as const, { agent_id: agentIds, status: { neq: 'idle' } }, { column: 'updated_at', ascending: false }, 500)
    return data?.map(s => ({ observation: sessionObservationOf(s), id: s.id, agentId: s.agent_id, originAgentId: s.origin_agent_id, status: (s.status as SessionStatus) || 'idle' })) ?? null
}

// Reconciles stale working sessions through the server; the browser never writes execution state.
// `idleAmong` answers which of the candidates the engine confirmed have no run in flight; one it
// could not ask stays out of that answer, and so stays working.
export async function sweepZombieSessions(supabase: Client, sessions: SessionEntry[], idleAmong: (sessionIds: string[]) => Promise<string[]>): Promise<string[]> {
    const staleSessionIds = sessions.filter(s => s.status === 'working').map(s => s.id)
    if (staleSessionIds.length === 0) return []

    const now = Date.now()
    const { data: fullSessions } = await selectMany(supabase, 'sessions', ['id', 'updated_at'] as const, { id: staleSessionIds })

    const candidates = (fullSessions ?? [])
        .filter(s => s.updated_at && now - new Date(s.updated_at).getTime() > STALE_THRESHOLD_MS)
        .slice(0, STALE_CHECK_LIMIT)
        .map(s => s.id)
    if (candidates.length === 0) return []

    // Silence is not proof a run is over: a legitimate long run writes nothing for an hour,
    // and marking it idle here used to hide it from the board while it was still working.
    // The engine is the only authority on that.
    const zombieIds = await idleAmong(candidates).catch((): string[] => [])
    if (zombieIds.length === 0) return []

    return zombieIds
}
