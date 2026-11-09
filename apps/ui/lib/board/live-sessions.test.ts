import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEntry } from '@/lib/board/types'
import { fakeSupabase } from '@/test/supabase-fake'
import { fetchLiveSessions, sweepZombieSessions } from './live-sessions'

const NOW = new Date('2026-09-30T12:00:00Z').getTime()
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const session = (id: string, status: SessionEntry['status'] = 'working'): SessionEntry => ({ id, agentId: 'a1', originAgentId: null, status })

function setup(rows: { id: string; updated_at: string | null }[]) {
    return fakeSupabase((table, calls) => (table === 'sessions' && !calls.some(c => c.method === 'update') ? { data: rows } : undefined))
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
})

afterEach(() => {
    vi.useRealTimers()
})

describe('sweepZombieSessions', () => {
    it('reads nothing when no session is working', async () => {
        const db = setup([])
        await sweepZombieSessions(db.client, [session('s1', 'idle'), session('s2', 'waiting_human' as SessionEntry['status'])], vi.fn())
        expect(db.calls).toEqual([])
    })

    it('reconciles on the server without browser writes or stale local state mutation', async () => {
        const db = setup([{ id: 's1', updated_at: minutesAgo(6) }])
        const sessions = [session('s1')]
        await sweepZombieSessions(db.client, sessions, async ids => ids)
        expect(db.writes('sessions')).toEqual([])
        expect(sessions[0].status).toBe('working')
    })

    it('never asks the engine about a session updated in the last five minutes or never updated', async () => {
        const idleAmong = vi.fn(async (ids: string[]) => ids)
        const db = setup([
            { id: 'fresh', updated_at: minutesAgo(4) },
            { id: 'never', updated_at: null },
        ])
        await sweepZombieSessions(db.client, [session('fresh'), session('never')], idleAmong)
        expect(idleAmong).not.toHaveBeenCalled()
        expect(db.writes('sessions')).toEqual([])
    })

    it('keeps a session the engine still runs, or could not answer for, as working', async () => {
        const db = setup([
            { id: 'running', updated_at: minutesAgo(60) },
            { id: 'unreachable', updated_at: minutesAgo(60) },
            { id: 'done', updated_at: minutesAgo(60) },
        ])
        const sessions = [session('running'), session('unreachable'), session('done')]
        await sweepZombieSessions(db.client, sessions, async ids => ids.filter(id => id === 'done'))
        expect(sessions.map(s => s.status)).toEqual(['working', 'working', 'working'])
        expect(db.writes('sessions')).toEqual([])
    })

    it('keeps every candidate working when the engine cannot be asked at all', async () => {
        const db = setup([{ id: 's1', updated_at: minutesAgo(60) }])
        const sessions = [session('s1')]
        await sweepZombieSessions(db.client, sessions, async () => {
            throw new Error('engine down')
        })
        expect(sessions[0].status).toBe('working')
        expect(db.writes('sessions')).toEqual([])
    })

    it('checks at most ten sessions per sweep', async () => {
        const rows = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, updated_at: minutesAgo(30) }))
        const idleAmong = vi.fn(async (ids: string[]) => ids)
        await sweepZombieSessions(setup(rows).client, rows.map(r => session(r.id)), idleAmong)
        expect(idleAmong).toHaveBeenCalledTimes(1)
        expect(idleAmong.mock.calls[0][0]).toHaveLength(10)
    })
})

describe('fetchLiveSessions', () => {
    it('maps the non-idle sessions newest first and reports a failed read as null', async () => {
        const db = fakeSupabase(() => ({ data: [{ id: 's1', agent_id: 'a1', origin_agent_id: 'a0', status: 'working' }] }))
        expect(await fetchLiveSessions(db.client, ['a1'])).toEqual([{ observation: null, id: 's1', agentId: 'a1', originAgentId: 'a0', status: 'working' }])
        const [chain] = db.chainsOn('sessions')
        expect(chain).toContainEqual({ table: 'sessions', method: 'neq', args: ['status', 'idle'] })
        expect(chain).toContainEqual({ table: 'sessions', method: 'order', args: ['updated_at', { ascending: false }] })
        expect(await fetchLiveSessions(fakeSupabase(() => ({ error: { message: 'x' } })).client, ['a1'])).toBeNull()
    })
})
