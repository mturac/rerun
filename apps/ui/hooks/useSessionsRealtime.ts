'use client'

import { sessionObservationOf } from '@/lib/board/session-execution'
import type { SessionStatus } from '@/lib/board/types'
import { useBoardStore } from '@/stores/board.store'
import { useRealtimeSubscription } from '@/supabase/useRealtimeSubscription'

export function useSessionsRealtime(enabled: boolean) {
    const _onSessionInsert = useBoardStore(s => s._onSessionInsert)
    const _onSessionUpdate = useBoardStore(s => s._onSessionUpdate)
    const _onSessionDelete = useBoardStore(s => s._onSessionDelete)

    useRealtimeSubscription('sessions', {
        channelId: `sessions-status`,
        enabled,
        onResync: () => {
            void useBoardStore.getState().reconcileSessions()
        },
        onInsert: row => {
            _onSessionInsert({
                observation: sessionObservationOf(row),
                id: row.id,
                agentId: row.agent_id,
                originAgentId: row.origin_agent_id,
                status: (row.status as SessionStatus) || 'idle',
            })
        },
        onUpdate: row => {
            _onSessionUpdate({
                observation: sessionObservationOf(row),
                id: row.id,
                agentId: row.agent_id,
                originAgentId: row.origin_agent_id,
                status: (row.status as SessionStatus) || 'idle',
            })
        },
        onDelete: row => {
            if (row.id) _onSessionDelete(row.id)
        },
    })
}
