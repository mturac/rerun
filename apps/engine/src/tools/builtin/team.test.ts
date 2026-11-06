import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-team-tools-'))
process.env.RERUN_API_KEY = ''

const calls = vi.hoisted(() => [] as Array<{ agentId: string; tool: string; args: Record<string, unknown> }>)

vi.mock('../../runtime/hub.js', () => ({
    callHub: async (caller: { id: string }, tool: string, args: Record<string, unknown>) => {
        calls.push({ agentId: caller.id, tool, args })
        return { tool }
    },
}))

const { beforeEach, describe, expect, it } = await import('vitest')
const { teamTools } = await import('./team.js')

const tools = teamTools({ agent: { id: 'auditor' } } as any)

function run(name: string, args: Record<string, unknown>) {
    const t = tools[name] as any
    return t.execute(t.inputSchema.parse(args), { toolCallId: 'c', messages: [] })
}

beforeEach(() => {
    calls.length = 0
})

describe('teamTools', () => {
    it('exposes only the five read tools', () => {
        expect(Object.keys(tools).sort()).toEqual(['team_get_run', 'team_list_runs', 'team_list_schedules', 'team_list_triggers', 'team_status'])
    })

    it.each([
        ['team_status', {}],
        ['team_status', { agentId: 'a1' }],
        ['team_list_schedules', { agentId: 'a1' }],
        ['team_list_triggers', { agentId: 'a1' }],
        ['team_list_runs', { agentId: 'a1', limit: 5 }],
        ['team_get_run', { agentId: 'a1', runId: 'r1', includeToolCalls: true }],
    ])('%s goes to the hub under its own name, as the calling coworker', async (name, args) => {
        expect(await run(name, args)).toEqual({ tool: name })
        expect(calls).toEqual([{ agentId: 'auditor', tool: name, args }])
    })

    it('needs a coworker id to read its schedules, triggers and runs', () => {
        for (const name of ['team_list_schedules', 'team_list_triggers', 'team_list_runs', 'team_get_run']) {
            expect(() => (tools[name] as any).inputSchema.parse({})).toThrow()
        }
    })
})
