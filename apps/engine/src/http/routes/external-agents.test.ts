import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-extagents-'))
process.env.RERUN_API_KEY = ''

const { describe, expect, it, vi, beforeAll } = await import('vitest')

const state = vi.hoisted(() => ({
    providers: [] as { name: string; status: (id: string) => Promise<unknown> }[],
}))

vi.mock('../../external-agents/index.js', () => ({
    configuredProviders: () => state.providers,
}))

const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir } = await import('../../config/paths.js')

const id = 'extagent'
const app = createServer()

beforeAll(async () => {
    await import('node:fs/promises').then(fs => fs.mkdir(agentDir(id), { recursive: true }))
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'ext' }))
})

describe('GET /agents/:id/external-agents/:provider/:taskId', () => {
    it('answers 404 for an agent that does not exist', async () => {
        const res = await app.request('/agents/ghost/external-agents/cursor/bc-1')
        expect(res.status).toBe(404)
    })

    it('answers 404 for a provider that is not configured', async () => {
        state.providers = []
        const res = await app.request(`/agents/${id}/external-agents/cursor/bc-1`)
        expect(res.status).toBe(404)
    })

    it('returns the live task without its raw payload', async () => {
        state.providers = [
            {
                name: 'cursor',
                status: async taskId => ({ provider: 'cursor', id: taskId, name: 'Fix it', status: 'completed', prUrl: 'https://github.com/o/r/pull/1', raw: { secret: true } }),
            },
        ]
        const res = await app.request(`/agents/${id}/external-agents/cursor/bc-1`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean; provider: string; task: Record<string, unknown> }
        expect(body.ok).toBe(true)
        expect(body.provider).toBe('cursor')
        expect(body.task).toMatchObject({ id: 'bc-1', status: 'completed', prUrl: 'https://github.com/o/r/pull/1' })
        expect(body.task).not.toHaveProperty('raw')
    })

    it('answers 502 when the provider fails', async () => {
        state.providers = [
            {
                name: 'cursor',
                status: async () => {
                    throw new Error('provider down')
                },
            },
        ]
        const res = await app.request(`/agents/${id}/external-agents/cursor/bc-1`)
        expect(res.status).toBe(502)
    })
})
