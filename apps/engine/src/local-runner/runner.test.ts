import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalRunnerApp } from './runner.js'
import type { SpawnImpl } from './executor.js'

const TOKEN = 'test-token'

function tmpDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix))
}

function fakeSpawn(exit: { code?: number; stdout?: string; stderr?: string } = {}): SpawnImpl {
    const impl = (() => {
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter
            stderr: EventEmitter
            kill: () => boolean
        }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => true
        queueMicrotask(() => {
            if (exit.stdout) child.stdout.emit('data', Buffer.from(exit.stdout))
            if (exit.stderr) child.stderr.emit('data', Buffer.from(exit.stderr))
            child.emit('close', exit.code ?? 0)
        })
        return child
    }) as unknown as SpawnImpl
    return impl
}

function app(overrides: Partial<Parameters<typeof createLocalRunnerApp>[0]> = {}) {
    const rootDir = overrides.rootDir ?? tmpDir('rerun-lr-root-')
    const dataDir = overrides.dataDir ?? tmpDir('rerun-lr-data-')
    return createLocalRunnerApp({ token: TOKEN, rootDir, dataDir, spawnImpl: fakeSpawn({ code: 0, stdout: 'ok' }), ...overrides })
}

async function post(a: ReturnType<typeof app>, path: string, body: unknown, token: string | null = TOKEN) {
    return a.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    })
}

describe('local runner auth', () => {
    it('rejects requests without the bearer token', async () => {
        const a = app()
        expect((await post(a, '/tasks', { kind: 'shell', command: 'ls' }, null)).status).toBe(401)
        expect((await post(a, '/tasks', { kind: 'shell', command: 'ls' }, 'wrong')).status).toBe(401)
        expect((await a.request('/health')).status).toBe(401)
    })
})

describe('ask mode flow', () => {
    it('parks a task as pending, then approve executes it and can persist a grant', async () => {
        const a = app({ mode: 'ask' })
        const res = await post(a, '/tasks', { kind: 'shell', command: 'ls -la', subject: 'repo-a' })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string; pendingId: string; approvalText: string }
        expect(body.status).toBe('pending')
        expect(body.approvalText).toContain('ls -la')

        const approved = await post(a, `/approvals/${body.pendingId}`, { decision: 'approve', scope: 'always' })
        const result = (await approved.json()) as { status: string; stdout?: string }
        expect(result.status).toBe('completed')
        expect(result.stdout).toBe('ok')

        const grants = (await (await a.request('/grants', { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as {
            grants: { subject: string; action: string }[]
        }
        expect(grants.grants).toEqual([{ subject: 'repo-a', action: 'shell:ls -la', grantedAtMs: expect.any(Number) }])

        const second = (await (await post(a, '/tasks', { kind: 'shell', command: 'ls -la', subject: 'repo-a' })).json()) as { status: string }
        expect(second.status).toBe('completed')
    })

    it('deny records denial memory: the same taskKey is refused without asking again', async () => {
        const a = app({ mode: 'ask' })
        const first = (await (await post(a, '/tasks', { kind: 'shell', command: 'rm x', taskKey: 'danger' })).json()) as { pendingId: string }
        const denied = await post(a, `/approvals/${first.pendingId}`, { decision: 'deny' })
        expect(((await denied.json()) as { status: string }).status).toBe('denied')

        const again = (await (await post(a, '/tasks', { kind: 'shell', command: 'rm x', taskKey: 'danger' })).json()) as {
            status: string
            reason: string
        }
        expect(again.status).toBe('denied')
        expect(again.reason).toBe('denied-before')
        expect(again).not.toHaveProperty('pendingId')
    })

    it('lists pending approvals and drops them once resolved or expired', async () => {
        const a = app({ mode: 'ask' })
        const auth = { headers: { authorization: `Bearer ${TOKEN}` } }
        expect((await a.request('/approvals')).status).toBe(401)

        await post(a, '/tasks', { kind: 'shell', command: 'ls -la', subject: 'repo-a' })
        await post(a, '/tasks', { kind: 'file.read', path: 'notes.txt' })
        const list = (await (await a.request('/approvals', auth)).json()) as {
            approvals: { id: string; approvalText: string; taskKey: string; kind: string; expiresAt: string }[]
        }
        expect(list.approvals).toHaveLength(2)
        expect(list.approvals[0]).toMatchObject({ kind: 'shell', subject: 'repo-a' })
        expect(list.approvals[0].approvalText).toContain('ls -la')
        expect(list.approvals[0].expiresAt).toEqual(expect.any(String))

        await post(a, `/approvals/${list.approvals[0].id}`, { decision: 'deny' })
        const after = (await (await a.request('/approvals', auth)).json()) as { approvals: { id: string }[] }
        expect(after.approvals).toHaveLength(1)
        expect(after.approvals[0].id).toBe(list.approvals[1].id)
    })

    it('pendings survive a daemon restart and resolve on the new instance', async () => {
        const dataDir = tmpDir('rerun-lr-data-')
        const first = app({ mode: 'ask', dataDir })
        const created = (await (await post(first, '/tasks', { kind: 'shell', command: 'ls -la', subject: 'repo-a' })).json()) as { pendingId: string }
        const auth = { headers: { authorization: `Bearer ${TOKEN}` } }

        const second = app({ mode: 'ask', dataDir })
        const list = (await (await second.request('/approvals', auth)).json()) as { approvals: { id: string; approvalText: string }[] }
        expect(list.approvals).toHaveLength(1)
        expect(list.approvals[0].id).toBe(created.pendingId)
        expect(list.approvals[0].approvalText).toContain('ls -la')

        const approved = await post(second, `/approvals/${created.pendingId}`, { decision: 'approve' })
        expect(((await approved.json()) as { status: string }).status).toBe('completed')
        const after = (await (await second.request('/approvals', auth)).json()) as { approvals: unknown[] }
        expect(after.approvals).toHaveLength(0)
    })

    it('unknown approval ids 404 and expired pendings 410', async () => {
        const a = app({ mode: 'ask', pendingTtlMs: -1 })
        const created = (await (await post(a, '/tasks', { kind: 'shell', command: 'ls' })).json()) as { pendingId: string }
        const res = await post(a, `/approvals/${created.pendingId}`, { decision: 'approve' })
        expect(res.status).toBe(410)
        expect((await post(a, '/approvals/nope', { decision: 'approve' })).status).toBe(404)
    })
})

describe('modes and allowlist', () => {
    it('never mode denies without pending', async () => {
        const a = app({ mode: 'never' })
        const body = (await (await post(a, '/tasks', { kind: 'shell', command: 'ls' })).json()) as { status: string; reason: string }
        expect(body).toMatchObject({ status: 'denied', reason: 'mode-never' })
    })

    it('always mode executes directly and persists a kind-level grant', async () => {
        const dataDir = tmpDir('rerun-lr-data-')
        const a = app({ mode: 'always', dataDir })
        const body = (await (await post(a, '/tasks', { kind: 'file.read', path: 'notes.txt', subject: 'repo-a' })).json()) as { status: string }
        expect(body.status).toBe('failed')
        const grants = (await (await a.request('/grants', { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as {
            grants: { action: string }[]
        }
        expect(grants.grants.map(g => g.action)).toContain('file.read')
    })

    it('empty allowlist is off by default; configured allowlist denies unlisted subjects', async () => {
        const open = app({ mode: 'ask', allowlist: [] })
        expect(((await (await post(open, '/tasks', { kind: 'shell', command: 'ls', subject: 'any' })).json()) as { status: string }).status).toBe('pending')

        const closed = app({ mode: 'ask', allowlist: ['team/app'] })
        const denied = (await (await post(closed, '/tasks', { kind: 'shell', command: 'ls', subject: 'other/repo' })).json()) as {
            status: string
            reason: string
        }
        expect(denied).toMatchObject({ status: 'denied', reason: 'allowlist' })
        const allowed = (await (await post(closed, '/tasks', { kind: 'shell', command: 'ls', subject: 'team/app' })).json()) as { status: string }
        expect(allowed.status).toBe('pending')
    })
})

describe('file tasks', () => {
    it('file.write then file.read round-trips inside the root', async () => {
        const rootDir = tmpDir('rerun-lr-root-')
        const a = app({ mode: 'always', rootDir })
        const write = (await (await post(a, '/tasks', { kind: 'file.write', path: 'sub/hi.txt', content: 'hello' })).json()) as { status: string }
        expect(write.status).toBe('completed')
        const read = (await (await post(a, '/tasks', { kind: 'file.read', path: 'sub/hi.txt' })).json()) as { status: string; stdout?: string }
        expect(read.status).toBe('completed')
        expect(read.stdout).toBe('hello')
        expect(readFileSync(join(rootDir, 'sub', 'hi.txt'), 'utf8')).toBe('hello')
    })

    it('paths escaping the root fail even in always mode', async () => {
        const a = app({ mode: 'always' })
        const body = (await (await post(a, '/tasks', { kind: 'file.read', path: '../outside.txt' })).json()) as { status: string; error?: string }
        expect(body.status).toBe('failed')
        expect(body.error).toContain('escapes')
    })
})
