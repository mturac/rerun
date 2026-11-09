import { Hono } from 'hono'
import { agentExists } from '../../agents/loader.js'
import { readAgentEnv } from '../../agents/env.js'
import { configuredProviders } from '../../external-agents/index.js'

export const externalAgentRoutes = new Hono()

// The chat card only holds the snapshot its tool call froze; this is the live read behind it,
// so a queued or running cloud agent can be watched without asking the model to poll again.
externalAgentRoutes.get('/:provider/:taskId', async c => {
    const agentId = c.req.param('id')!
    if (!agentExists(agentId)) return c.json({ error: 'agent not found' }, 404)
    const providerName = c.req.param('provider')!
    const provider = configuredProviders(agentId, await readAgentEnv(agentId)).find(candidate => candidate.name === providerName)
    if (!provider) return c.json({ error: `Unknown or unconfigured external agent provider "${providerName}"` }, 404)
    try {
        const { raw: _raw, ...task } = await provider.status(c.req.param('taskId')!)
        return c.json({ ok: true, provider: provider.name, task })
    } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'The provider did not answer' }, 502)
    }
})
