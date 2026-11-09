import { describe, expect, it } from 'vitest'
import { externalAgentCardOf, externalAgentTaskLive, EXTERNAL_AGENT_STATUSES } from './external-agent-card'

const task = { provider: 'cursor', id: 'bc-123', name: 'Fix the flaky test', status: 'running', url: 'https://cursor.com/agents/bc-123' }
const output = { ok: true, provider: 'cursor', task }

describe('externalAgentCardOf', () => {
    it('reads a started task as a card', () => {
        expect(externalAgentCardOf('external_agent_start', output)).toEqual({ provider: 'cursor', providerLabel: 'Cursor', action: 'started', task: { ...task, url: task.url, prUrl: undefined, summary: undefined, branch: undefined, error: undefined } })
    })

    it('maps each tool to its action', () => {
        expect(externalAgentCardOf('external_agent_status', output)?.action).toBe('checked')
        expect(externalAgentCardOf('external_agent_followup', output)?.action).toBe('followed-up')
    })

    it('reads the output reloaded from history behind its envelope', () => {
        const enveloped = { type: 'json', value: JSON.stringify([{ type: 'text', text: JSON.stringify(output) }]) }
        expect(externalAgentCardOf('external_agent_status', enveloped)?.task.id).toBe('bc-123')
    })

    it('keeps the fields a finished run carries', () => {
        const done = { ok: true, provider: 'codex', task: { ...task, status: 'completed', prUrl: 'https://github.com/o/r/pull/1', summary: 'Opened a PR', branch: 'rerun/fix' } }
        const card = externalAgentCardOf('external_agent_status', done)
        expect(card?.task.prUrl).toBe('https://github.com/o/r/pull/1')
        expect(card?.providerLabel).toBe('Codex')
    })

    it('degrades an unknown status instead of dropping the card', () => {
        const odd = { ok: true, provider: 'cursor', task: { ...task, status: 'exploded' } }
        expect(externalAgentCardOf('external_agent_status', odd)?.task.status).toBe('unknown')
    })

    it('leaves errors, lists and stops to the plain tool step', () => {
        expect(externalAgentCardOf('external_agent_start', { error: 'No external agent provider is configured' })).toBeNull()
        expect(externalAgentCardOf('external_agent_list', { ok: true, provider: 'cursor', tasks: [task] })).toBeNull()
        expect(externalAgentCardOf('external_agent_stop', { ok: true, provider: 'cursor', id: 'bc-123' })).toBeNull()
    })
})

describe('externalAgentTaskLive', () => {
    it('polls only non-terminal statuses', () => {
        expect(externalAgentTaskLive('queued')).toBe(true)
        expect(externalAgentTaskLive('running')).toBe(true)
        expect(externalAgentTaskLive('unknown')).toBe(true)
        expect(externalAgentTaskLive('completed')).toBe(false)
        expect(externalAgentTaskLive('failed')).toBe(false)
        expect(externalAgentTaskLive('stopped')).toBe(false)
    })

    it('covers every declared status', () => {
        for (const status of EXTERNAL_AGENT_STATUSES) expect(typeof externalAgentTaskLive(status)).toBe('boolean')
    })
})
