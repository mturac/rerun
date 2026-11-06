import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveAgentTarget } from '@/app/api/_services/chat.service'
import { dispatchAccountTool } from '@/app/api/_services/mcp-account.service'
import { getAgent } from '@/lib/engine/client'

import { dispatchTeamHubTool, isTeamHubTool } from './team-hub.service'

vi.mock('@/app/api/_services/chat.service', () => ({ resolveAgentTarget: vi.fn() }))
vi.mock('@/app/api/_services/mcp-account.service', () => ({ dispatchAccountTool: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ getAgent: vi.fn() }))

const WORKSPACE_ID = 7

function callerWithTeam(team: boolean) {
    vi.mocked(getAgent).mockResolvedValue({ config: { tools: { team } } } as never)
}

describe('dispatchTeamHubTool', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(resolveAgentTarget).mockResolvedValue({ conn: { baseUrl: 'https://box', apiKey: 'k' }, engineAgentId: 'engine-auditor' } as never)
        vi.mocked(dispatchAccountTool).mockResolvedValue({ ok: true })
        callerWithTeam(true)
    })

    it('knows only the five read tools', () => {
        for (const name of ['team_status', 'team_list_schedules', 'team_list_triggers', 'team_list_runs', 'team_get_run']) expect(isTeamHubTool(name)).toBe(true)
        for (const name of ['upsert_schedule', 'delete_agent', 'send_message', 'run_schedule_now', 'team_delete', 'toString', 'constructor']) expect(isTeamHubTool(name)).toBe(false)
    })

    it.each([
        ['team_status', 'get_team_status'],
        ['team_list_schedules', 'list_schedules'],
        ['team_list_runs', 'list_runs'],
        ['team_get_run', 'get_run'],
    ] as const)('reads %s through the account tool %s, as the workspace', async (name, accountTool) => {
        const args = { agentId: 'a1', runId: 'r1' }
        expect(await dispatchTeamHubTool('auditor', WORKSPACE_ID, name, args)).toEqual({ ok: true })
        expect(dispatchAccountTool).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: WORKSPACE_ID }, accountTool, args)
    })

    it('checks the switch on the calling coworker', async () => {
        await dispatchTeamHubTool('auditor', WORKSPACE_ID, 'team_status', {})
        expect(resolveAgentTarget).toHaveBeenCalledWith('auditor', expect.objectContaining({ workspaceId: WORKSPACE_ID }))
        expect(getAgent).toHaveBeenCalledWith({ baseUrl: 'https://box', apiKey: 'k' }, 'engine-auditor')
    })

    it('refuses when the switch is off, before reading anything', async () => {
        callerWithTeam(false)
        await expect(dispatchTeamHubTool('auditor', WORKSPACE_ID, 'team_list_runs', { agentId: 'a1' })).rejects.toThrow('switched off')
        expect(dispatchAccountTool).not.toHaveBeenCalled()
    })

    it('keeps the webhook URLs, which carry their secret, out of the triggers', async () => {
        vi.mocked(dispatchAccountTool).mockResolvedValue({ triggers: [{ slug: 'stripe', name: 'Stripe', url: 'https://hub/t/secret', fireCount: 3 }] })
        expect(await dispatchTeamHubTool('auditor', WORKSPACE_ID, 'team_list_triggers', { agentId: 'a1' })).toEqual({ triggers: [{ slug: 'stripe', name: 'Stripe', fireCount: 3 }] })
        expect(dispatchAccountTool).toHaveBeenCalledWith(expect.anything(), 'list_triggers', { agentId: 'a1' })
    })
})
