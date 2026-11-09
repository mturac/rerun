import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { dataDir, localRunnerDir } from '../../config/paths.js'
import { createLocalRunnerApp } from '../../local-runner/runner.js'
import { isValidAnnounceUrl } from '../../local-runner/credentials.js'
import { resolveAllowlist } from '../../local-runner/permissions.js'
import { runnerModeSchema } from '../../local-runner/types.js'

type SavedCredential = { engineUrl: string; id: string; name: string; token: string; pairedAt: string }

const credentialPath = () => resolve(localRunnerDir(), 'credential.json')

function parseFlags(args: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2)
            out[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true'
        }
    }
    return out
}

const USAGE = 'Usage: rerun local-runner pair --engine <url> [--name <name>] [--api-key <key>]\n' +
    '       rerun local-runner start [--port 4700] [--host 127.0.0.1] [--root <dir>] [--mode never|ask|always] [--allow repo1,repo2] [--announce-url <url>] [--token <t>] [--engine <url>]\n'

export async function localRunnerCommand(args: string[]): Promise<void> {
    const sub = args[0]
    const flags = parseFlags(args.slice(1))

    if (sub === 'pair') {
        const engineUrl = (flags.engine ?? '').replace(/\/+$/, '')
        if (!engineUrl) throw new Error(USAGE)
        const apiKey = flags['api-key'] ?? process.env.RERUN_API_KEY
        const response = await fetch(`${engineUrl}/local-runner`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ name: flags.name ?? 'local runner' }),
        })
        const body = (await response.json().catch(() => ({}))) as { id?: string; name?: string; token?: string; error?: string }
        if (!response.ok || typeof body.token !== 'string') throw new Error(body.error ?? `pairing failed (${response.status})`)
        mkdirSync(localRunnerDir(), { recursive: true })
        const saved: SavedCredential = { engineUrl, id: body.id ?? '', name: body.name ?? 'local runner', token: body.token, pairedAt: new Date().toISOString() }
        writeFileSync(credentialPath(), JSON.stringify(saved, null, 2), { mode: 0o600 })
        process.stdout.write(`Paired with ${engineUrl} as "${saved.name}". Start the runner with: rerun local-runner start\n`)
        return
    }

    if (sub === 'start') {
        let saved: SavedCredential | null = null
        if (existsSync(credentialPath())) saved = JSON.parse(readFileSync(credentialPath(), 'utf8')) as SavedCredential
        // The serving token is the runner's own: paired starts get a fresh one so the engine can
        // store it for dispatch without ever holding the rlr_ credential in plaintext.
        const token = flags.token ?? (saved ? `rlrs_${randomBytes(24).toString('hex')}` : undefined)
        if (!token) throw new Error(`No pairing found; run \`rerun local-runner pair --engine <url>\` first or pass --token\n${USAGE}`)
        const mode = runnerModeSchema.parse(flags.mode ?? 'ask')
        const rawAllowlist = flags.allow
            ? flags.allow.split(',').map(entry => entry.trim()).filter(Boolean)
            : undefined
        const port = flags.port ? Number(flags.port) : 4700
        if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${flags.port}`)
        const host = flags.host ?? '127.0.0.1'
        const rootDir = resolve(flags.root ?? process.cwd())
        // repo: allowlist entries are verified against this root's git remotes; unverified ones
        // are dropped with a warning so a typo cannot silently widen or empty the allowlist.
        const resolved = resolveAllowlist(rawAllowlist, rootDir)
        for (const warning of resolved.warnings) process.stdout.write(`warning: ${warning}\n`)
        const announceOverride = flags['announce-url']?.replace(/\/+$/, '')
        if (announceOverride !== undefined && !isValidAnnounceUrl(announceOverride)) {
            throw new Error(`Invalid --announce-url '${flags['announce-url']}': expected an http(s) URL with a host`)
        }
        const app = createLocalRunnerApp({ token, rootDir, dataDir: dataDir(), mode, allowlist: rawAllowlist ? resolved.entries : undefined })
        serve({ fetch: app.fetch, port, hostname: host }, info => {
            const url = announceOverride ?? `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${info.port}`
            warnIfInsecureAnnounce(url)
            process.stdout.write(`local runner listening on http://${host}:${info.port} (root: ${rootDir}, mode: ${mode})\n`)
            void announceToEngine(url, token, saved, flags.engine)
        })
        return
    }

    throw new Error(USAGE)
}

function warnIfInsecureAnnounce(url: string): void {
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:') return
        const host = parsed.hostname
        const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.')
        if (!loopback) {
            process.stdout.write(`warning: announcing ${url} over plain HTTP; the bearer token and task traffic are unencrypted — use https:// or a tunnel\n`)
        }
    } catch {
        // URL shape was already validated for --announce-url; derived URLs are built by us.
    }
}

async function announceToEngine(baseUrl: string, serveToken: string, saved: SavedCredential | null, engineFlag: string | undefined): Promise<void> {
    const engineUrl = (engineFlag ?? saved?.engineUrl ?? '').replace(/\/+$/, '')
    const credential = saved?.token
    if (!engineUrl || !credential) return
    try {
        const res = await fetch(`${engineUrl}/local-runner/announce`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body: JSON.stringify({ url: baseUrl, token: serveToken }),
        })
        if (!res.ok) process.stdout.write(`announce to ${engineUrl} failed (${res.status}); the engine cannot dispatch tasks to this runner\n`)
    } catch (err) {
        process.stdout.write(`announce to ${engineUrl} failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
}
