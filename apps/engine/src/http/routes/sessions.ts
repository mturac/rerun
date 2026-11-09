import { Hono } from 'hono'
import { getSession, listSessions, sessionBelongsToAgent } from '../../db/repos/sessions.js'
import { listMessages } from '../../db/repos/messages.js'
import { getSessionExecution } from '../../db/repos/execution.js'

export const sessionRoutes = new Hono()

sessionRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    return c.json({ sessions: await listSessions(agentId) })
})

sessionRoutes.get('/:sid', async c => {
    const agentId = c.req.param('id')!
    const session = await getSession(agentId, c.req.param('sid'))
    if (!session || session.agentId !== agentId) return c.json({ error: 'session not found' }, 404)
    return c.json(session)
})

sessionRoutes.get('/:sid/messages', async c => {
    const agentId = c.req.param('id')!
    const sid = c.req.param('sid')
    if (!(await sessionBelongsToAgent(sid, agentId))) return c.json({ error: 'session not found' }, 404)
    return c.json({ messages: await listMessages(agentId, sid) })
})

sessionRoutes.get('/:sid/execution', async c => {
    const agentId = c.req.param('id')!
    const sid = c.req.param('sid')
    if (!(await sessionBelongsToAgent(sid, agentId))) return c.json({ error: 'session not found' }, 404)
    return c.json({ execution: await getSessionExecution(agentId, sid) })
})
