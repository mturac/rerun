import { Hono } from 'hono'
import { z } from 'zod'
import { dataDir } from '../../config/paths.js'
import {
    announceRunner,
    issueRunnerCredential,
    listRunnerCredentials,
    pickRunnerTarget,
    revokeRunnerCredential,
    runnerCredentialByToken,
    runnerTargets,
    type RunnerTarget,
} from '../../local-runner/credentials.js'
import { notFound } from '../../lib/errors.js'

// Pairing for local runners: the engine issues a bearer token a `rerun local-runner` daemon on the
// user's machine presents when it serves shell/file tasks. The token is returned once; the engine
// keeps only its hash.

export const localRunnerRoutes = new Hono()

const pairSchema = z.object({ name: z.string().max(120).optional() }).default({})

localRunnerRoutes.post('/', async c => {
    const body = pairSchema.parse(await c.req.json().catch(() => ({})))
    const { credential, token } = issueRunnerCredential(dataDir(), body.name ?? 'local runner')
    return c.json({ id: credential.id, name: credential.name, token, createdAt: credential.createdAtMs }, 201)
})

localRunnerRoutes.get('/', c => c.json({ credentials: listRunnerCredentials(dataDir()) }))

localRunnerRoutes.delete('/:id', c => {
    if (!revokeRunnerCredential(dataDir(), c.req.param('id'))) throw notFound('runner credential')
    return c.json({ ok: true })
})

// Pending approvals live on each runner (persisted under its data dir, so they survive restarts),
// so the engine proxies the list and the decision
// to whichever announced runner holds them. `runner` (id or name) picks one; without it every
// runner is asked and the first that knows the approval answers.

const RUNNER_TIMEOUT_MS = 15_000

type PendingApprovalView = {
    id: string
    approvalText?: string
    taskKey?: string
    action?: string
    kind?: string
    subject?: string | null
    expiresAt?: string
}

localRunnerRoutes.get('/pending', async c => {
    const targets = runnerTargets(dataDir())
    const approvals: (PendingApprovalView & { runnerId: string; runnerName: string })[] = []
    const errors: string[] = []
    await Promise.all(
        targets.map(async target => {
            try {
                const res = await fetch(`${target.url}/approvals`, {
                    headers: { authorization: `Bearer ${target.token}` },
                    signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
                })
                if (!res.ok) {
                    errors.push(`${target.name}: HTTP ${res.status}`)
                    return
                }
                const body = (await res.json().catch(() => ({}))) as { approvals?: PendingApprovalView[] }
                for (const approval of body.approvals ?? []) {
                    approvals.push({ ...approval, runnerId: target.id, runnerName: target.name })
                }
            } catch (err) {
                errors.push(`${target.name}: ${err instanceof Error ? err.message : String(err)}`)
            }
        }),
    )
    return c.json({ approvals, errors })
})

const resolveSchema = z.object({
    runner: z.string().max(120).optional(),
    decision: z.enum(['approve', 'deny']),
    scope: z.enum(['once', 'always']).optional(),
})

localRunnerRoutes.post('/approvals/:id', async c => {
    const body = resolveSchema.parse(await c.req.json())
    const id = c.req.param('id')
    const targets = runnerTargets(dataDir())
    const wanted = body.runner ? pickRunnerTarget(targets, body.runner) : null
    if (body.runner && !wanted) return c.json({ error: `No local runner matches "${body.runner}"` }, 404)
    const candidates: RunnerTarget[] = wanted ? [wanted] : targets
    if (candidates.length === 0) return c.json({ error: 'No local runner is registered on this engine' }, 404)

    const errors: string[] = []
    for (const target of candidates) {
        let res: Response
        try {
            res = await fetch(`${target.url}/approvals/${id}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
                body: JSON.stringify({ decision: body.decision, ...(body.scope ? { scope: body.scope } : {}) }),
                signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
            })
        } catch (err) {
            errors.push(`${target.name}: ${err instanceof Error ? err.message : String(err)}`)
            continue
        }
        if (res.status === 404 && candidates.length > 1 && !wanted) continue
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
        return c.json(payload, res.status === 404 ? 404 : res.status === 410 ? 410 : res.ok ? 200 : 502)
    }
    if (errors.length === candidates.length) return c.json({ error: `No runner answered: ${errors.join('; ')}` }, 502)
    return c.json({ error: 'Unknown or expired approval' }, 404)
})

// Mounted on the app outside the API-key middleware: a runner proves itself with the rlr_
// credential it paired with, which the engine only ever stores as a hash.
export const localRunnerAnnounceRoutes = new Hono()

const announceSchema = z.object({
    url: z.string().url().max(500),
    token: z.string().min(8).max(200),
})

localRunnerAnnounceRoutes.post('/announce', async c => {
    const header = c.req.header('authorization') ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : header
    const credential = presented ? runnerCredentialByToken(dataDir(), presented) : null
    if (!credential) return c.json({ error: 'Unauthorized' }, 401)
    const body = announceSchema.parse(await c.req.json())
    if (!announceRunner(dataDir(), credential.id, body)) return c.json({ error: 'Unknown credential' }, 404)
    return c.json({ ok: true })
})
