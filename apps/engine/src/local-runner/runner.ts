import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { approvalDecisionSchema, DEFAULT_PENDING_TTL_MS, runnerTaskSchema, type RunnerMode } from './types.js'
import { LocalRunnerApprovals, LocalRunnerStore } from './store.js'
import { approvalText, decidePermission, defaultTaskKey, grantAction } from './permissions.js'
import { executeTask, type SpawnImpl } from './executor.js'

export type LocalRunnerOptions = {
    token: string
    rootDir: string
    dataDir: string
    mode?: RunnerMode
    allowlist?: string[]
    store?: LocalRunnerStore
    approvals?: LocalRunnerApprovals
    spawnImpl?: SpawnImpl
    pendingTtlMs?: number
}

// The daemon side of the local-runner pair: an HTTP surface that runs shell/file tasks inside
// rootDir under the Never/Ask/Always permission model. Ask mode parks the task as a pending
// approval the caller resolves through /approvals/:id; pendings persist under dataDir so a
// restart does not strand them.
export function createLocalRunnerApp(options: LocalRunnerOptions): Hono {
    const mode = options.mode ?? 'ask'
    const ttl = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS
    const store = options.store ?? new LocalRunnerStore(options.dataDir)
    const approvals = options.approvals ?? new LocalRunnerApprovals(options.dataDir)
    const app = new Hono()

    app.use('*', async (c, next) => {
        const header = c.req.header('authorization') ?? ''
        const presented = header.startsWith('Bearer ') ? header.slice(7) : header
        if (presented !== options.token) return c.json({ error: 'Unauthorized' }, 401)
        return next()
    })

    app.get('/health', c => c.json({ status: 'ok', mode, rootDir: options.rootDir }))

    app.post('/tasks', async c => {
        const task = runnerTaskSchema.parse(await c.req.json())
        const taskKey = task.taskKey ?? defaultTaskKey(task)
        const action = grantAction(task)
        const decision = decidePermission({ mode, store, subject: task.subject, kind: task.kind, action, taskKey, allowlist: options.allowlist })
        if (decision.kind === 'deny') return c.json({ status: 'denied', reason: decision.reason, taskKey })
        if (decision.kind === 'ask') {
            const id = randomBytes(12).toString('hex')
            const expiresAtMs = Date.now() + ttl
            const text = approvalText(task)
            approvals.put({ id, task, taskKey, action, text, expiresAtMs })
            return c.json({ status: 'pending', pendingId: id, approvalText: text, taskKey, expiresAt: new Date(expiresAtMs).toISOString() })
        }
        if (decision.via === 'mode') store.addGrant(task.subject, task.kind)
        const result = await executeTask(task, options.rootDir, { spawnImpl: options.spawnImpl })
        return c.json({ taskKey, ...result })
    })

    app.get('/approvals', c => {
        const now = Date.now()
        const list = approvals.list(now)
        return c.json({
            approvals: list.map(pending => ({
                id: pending.id,
                approvalText: pending.text,
                taskKey: pending.taskKey,
                action: pending.action,
                kind: pending.task.kind,
                subject: pending.task.subject ?? null,
                expiresAt: new Date(pending.expiresAtMs).toISOString(),
            })),
        })
    })

    app.post('/approvals/:id', async c => {
        const body = approvalDecisionSchema.parse(await c.req.json())
        const id = c.req.param('id')
        const pending = approvals.take(id)
        if (!pending) return c.json({ error: 'Unknown or expired approval' }, 404)
        if (Date.now() > pending.expiresAtMs) return c.json({ error: 'Approval expired' }, 410)
        if (body.decision === 'deny') {
            store.addDenial(pending.taskKey, 'denied by caller')
            return c.json({ status: 'denied', reason: 'denied-before', taskKey: pending.taskKey })
        }
        if (body.scope === 'always') store.addGrant(pending.task.subject, pending.action)
        const result = await executeTask(pending.task, options.rootDir, { spawnImpl: options.spawnImpl })
        return c.json({ taskKey: pending.taskKey, ...result })
    })

    app.get('/grants', c => c.json({ grants: store.listGrants(), denials: store.listDenials() }))

    app.post('/permissions/clear-denials', async c => {
        const body = (await c.req.json().catch(() => ({}))) as { taskKey?: string }
        const removed = store.clearDenial(body.taskKey)
        return c.json({ removed })
    })

    return app
}
