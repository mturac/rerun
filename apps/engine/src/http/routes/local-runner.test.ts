import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-lrroutes-'))

const { describe, expect, it, vi, beforeEach } = await import('vitest')

const state = vi.hoisted(() => ({
    calls: [] as { url: string; init: RequestInit }[],
    responder: (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
}))

vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit) => {
        state.calls.push({ url: String(url), init })
        return state.responder(String(url), init)
    }),
)

const { createServer } = await import('../server.js')
const { runnerCredentialByToken, runnerTargets } = await import('../../local-runner/credentials.js')
const { dataDir } = await import('../../config/paths.js')

const app = createServer()

async function call(method: string, path: string, body?: unknown) {
    return app.request(`/local-runner${path === '/' ? '' : path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
}

describe('local-runner pairing routes', () => {
    it('issues a credential once and lists it without the token hash', async () => {
        const res = await call('POST', '/', { name: 'mehmet-mac' })
        expect(res.status).toBe(201)
        const issued = (await res.json()) as { id: string; name: string; token: string }
        expect(issued.name).toBe('mehmet-mac')
        expect(issued.token).toMatch(/^rlr_[0-9a-f]{48}$/)

        const list = (await (await call('GET', '/')).json()) as { credentials: Record<string, unknown>[] }
        expect(list.credentials).toHaveLength(1)
        expect(list.credentials[0]).toMatchObject({ id: issued.id, name: 'mehmet-mac' })
        expect(list.credentials[0]).not.toHaveProperty('tokenHash')
    })

    it('the issued token verifies against the stored hash and revoke removes it', async () => {
        const issued = (await (await call('POST', '/', {})).json()) as { id: string; token: string }
        expect(runnerCredentialByToken(dataDir(), issued.token)?.id).toBe(issued.id)

        const del = await call('DELETE', `/${issued.id}`)
        expect(del.status).toBe(200)
        expect(runnerCredentialByToken(dataDir(), issued.token)).toBeNull()
        expect((await call('DELETE', `/${issued.id}`)).status).toBe(404)
    })
})

async function announce(token: string | null, body: unknown) {
    return app.request('/local-runner/announce', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    })
}

describe('local-runner announce', () => {
    it('rejects a missing or wrong credential', async () => {
        const body = { url: 'http://127.0.0.1:4700', token: 'rlrs_serve_token_123456' }
        expect((await announce(null, body)).status).toBe(401)
        expect((await announce('rlr_not_a_real_token', body)).status).toBe(401)
    })

    it('validates the announced url and token', async () => {
        const issued = (await (await call('POST', '/', {})).json()) as { token: string }
        expect((await announce(issued.token, { url: 'not-a-url', token: 'rlrs_serve_token_123456' })).status).toBe(400)
        expect((await announce(issued.token, { url: 'http://127.0.0.1:4700', token: 'short' })).status).toBe(400)
    })

    it('records the runner url and serving token on the credential, hidden from lists', async () => {
        const issued = (await (await call('POST', '/', { name: 'announce-mac' })).json()) as { id: string; token: string }
        const res = await announce(issued.token, { url: 'http://127.0.0.1:4700', token: 'rlrs_serve_token_123456' })
        expect(res.status).toBe(200)

        const list = (await (await call('GET', '/')).json()) as { credentials: Record<string, unknown>[] }
        const cred = list.credentials.find(entry => entry.id === issued.id)!
        expect(cred.runnerUrl).toBe('http://127.0.0.1:4700')
        expect(cred.runnerSeenAtMs).toEqual(expect.any(Number))
        expect(cred).not.toHaveProperty('runnerToken')
        expect(cred).not.toHaveProperty('tokenHash')

        const target = runnerTargets(dataDir()).find(entry => entry.id === issued.id)
        expect(target).toMatchObject({ url: 'http://127.0.0.1:4700', token: 'rlrs_serve_token_123456', name: 'announce-mac' })
    })

    it('a revoked credential can no longer announce', async () => {
        const issued = (await (await call('POST', '/', {})).json()) as { id: string; token: string }
        await call('DELETE', `/${issued.id}`)
        const res = await announce(issued.token, { url: 'http://127.0.0.1:4700', token: 'rlrs_serve_token_123456' })
        expect(res.status).toBe(401)
    })
})

async function announcedRunner(name: string, url: string, serveToken: string) {
    const issued = (await (await call('POST', '/', { name })).json()) as { id: string; token: string }
    await announce(issued.token, { url, token: serveToken })
    return issued.id
}

describe('local-runner pending approvals proxy', () => {
    beforeEach(() => {
        state.calls.length = 0
        state.responder = () => new Response('{}', { status: 200 })
    })

    it('lists pendings from every announced runner, tagged with the runner', async () => {
        const id = await announcedRunner('pending-mac', 'http://127.0.0.1:4800', 'rlrs_pending')
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4800')
                ? new Response(
                      JSON.stringify({
                          approvals: [{ id: 'p1', approvalText: 'Run shell command: ls', taskKey: 'k', kind: 'shell', expiresAt: 'soon' }],
                      }),
                      { status: 200 },
                  )
                : new Response(JSON.stringify({ approvals: [] }), { status: 200 })
        const res = await call('GET', '/pending')
        expect(res.status).toBe(200)
        const body = (await res.json()) as { approvals: Record<string, unknown>[]; errors: string[] }
        expect(body.errors).toEqual([])
        expect(body.approvals).toHaveLength(1)
        expect(body.approvals[0]).toMatchObject({ id: 'p1', runnerId: id, runnerName: 'pending-mac' })
        const call0 = state.calls.find(entry => entry.url === 'http://127.0.0.1:4800/approvals')!
        expect((call0.init.headers as Record<string, string>).authorization).toBe('Bearer rlrs_pending')
    })

    it('proxies a decision to the runner that holds the approval', async () => {
        await announcedRunner('decide-mac', 'http://127.0.0.1:4810', 'rlrs_decide')
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4810')
                ? new Response(JSON.stringify({ status: 'denied', reason: 'denied-before', taskKey: 'k' }), { status: 200 })
                : new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        const res = await call('POST', '/approvals/p9', { decision: 'deny' })
        expect(res.status).toBe(200)
        expect(((await res.json()) as { status: string }).status).toBe('denied')
        const forwarded = state.calls.find(entry => entry.url === 'http://127.0.0.1:4810/approvals/p9')!
        expect(JSON.parse(String(forwarded.init.body))).toEqual({ decision: 'deny' })
    })

    it('passes scope through on approve and maps runner 404/410 through', async () => {
        await announcedRunner('scope-mac', 'http://127.0.0.1:4820', 'rlrs_scope')
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4820')
                ? new Response(JSON.stringify({ taskKey: 'k', status: 'completed', stdout: 'ok' }), { status: 200 })
                : new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        const ok = await call('POST', '/approvals/p1', { decision: 'approve', scope: 'always' })
        expect(ok.status).toBe(200)
        const forwarded = state.calls.find(entry => entry.url === 'http://127.0.0.1:4820/approvals/p1')!
        expect(JSON.parse(String(forwarded.init.body))).toEqual({ decision: 'approve', scope: 'always' })

        state.responder = () => new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        expect((await call('POST', '/approvals/nope', { decision: 'approve' })).status).toBe(404)
        state.responder = url =>
            url.startsWith('http://127.0.0.1:4820')
                ? new Response(JSON.stringify({ error: 'Approval expired' }), { status: 410 })
                : new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        expect((await call('POST', '/approvals/old', { decision: 'approve' })).status).toBe(410)
    })

    it('rejects a bad body and an unknown runner name', async () => {
        await announcedRunner('guard-mac', 'http://127.0.0.1:4830', 'rlrs_guard')
        expect((await call('POST', '/approvals/p1', { decision: 'maybe' })).status).toBe(400)
        expect((await call('POST', '/approvals/p1', { decision: 'approve', runner: 'ghost' })).status).toBe(404)
        expect(state.calls).toHaveLength(0)
    })

    it('answers 404 when the approval is unknown on every runner', async () => {
        state.responder = () => new Response(JSON.stringify({ error: 'Unknown or expired approval' }), { status: 404 })
        const res = await call('POST', '/approvals/p1', { decision: 'approve' })
        expect(res.status).toBe(404)
    })
})
