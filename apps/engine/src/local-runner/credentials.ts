import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Engine-side record of paired local runners. The bearer token is shown once at pair time; only
// its sha256 is kept, so a leaked credentials file does not leak usable tokens.

export type RunnerCredential = {
    id: string
    name: string
    tokenHash: string
    createdAtMs: number
    lastUsedAtMs: number | null
    // Where the runner announced it listens and the bearer token it serves tasks under. The rlr_
    // credential itself stays hash-only; this is the runner's own serving token, stored so the
    // engine can dispatch to it.
    runnerUrl?: string
    runnerToken?: string
    runnerSeenAtMs?: number
}

type CredentialsFile = { version: 1; credentials: RunnerCredential[] }

const FILE = 'credentials.json'
const EMPTY: CredentialsFile = { version: 1, credentials: [] }

const filePath = (dataDir: string) => join(dataDir, 'local-runner', FILE)

function load(dataDir: string): CredentialsFile {
    try {
        const parsed = JSON.parse(readFileSync(filePath(dataDir), 'utf8')) as Partial<CredentialsFile>
        if (parsed.version !== 1 || !Array.isArray(parsed.credentials)) return { ...EMPTY, credentials: [] }
        return { version: 1, credentials: parsed.credentials }
    } catch {
        return { version: 1, credentials: [] }
    }
}

function save(dataDir: string, data: CredentialsFile): void {
    const file = filePath(dataDir)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export function issueRunnerCredential(dataDir: string, name: string): { credential: RunnerCredential; token: string } {
    const data = load(dataDir)
    const token = `rlr_${randomBytes(24).toString('hex')}`
    const credential: RunnerCredential = {
        id: randomBytes(8).toString('hex'),
        name: name.slice(0, 120) || 'local runner',
        tokenHash: hashToken(token),
        createdAtMs: Date.now(),
        lastUsedAtMs: null,
    }
    data.credentials.push(credential)
    save(dataDir, data)
    return { credential, token }
}

export function listRunnerCredentials(dataDir: string): Omit<RunnerCredential, 'tokenHash' | 'runnerToken'>[] {
    return load(dataDir).credentials.map(({ tokenHash: _tokenHash, runnerToken: _runnerToken, ...rest }) => rest)
}

export function announceRunner(dataDir: string, credentialId: string, runner: { url: string; token: string }): boolean {
    const data = load(dataDir)
    const credential = data.credentials.find(entry => entry.id === credentialId)
    if (!credential || !isValidAnnounceUrl(runner.url)) return false
    credential.runnerUrl = runner.url
    credential.runnerToken = runner.token
    credential.runnerSeenAtMs = Date.now()
    save(dataDir, data)
    return true
}

export type RunnerTarget = { id: string; name: string; url: string; token: string; seenAtMs: number }

// Announce URLs are stored verbatim and later used as dispatch targets, so only plain
// http(s) URLs with a real host are accepted. TLS termination is the deployer's job (see the
// engine README); this check only rejects unparseable or host-less values.
export function isValidAnnounceUrl(url: string): boolean {
    try {
        const parsed = new URL(url)
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    } catch {
        return false
    }
}

export function runnerTargets(dataDir: string): RunnerTarget[] {
    return load(dataDir)
        .credentials
        .filter(credential => credential.runnerUrl && credential.runnerToken)
        .map(credential => ({
            id: credential.id,
            name: credential.name,
            url: credential.runnerUrl!,
            token: credential.runnerToken!,
            seenAtMs: credential.runnerSeenAtMs ?? 0,
        }))
        .sort((a, b) => b.seenAtMs - a.seenAtMs)
}

export function pickRunnerTarget(targets: RunnerTarget[], wanted: string | undefined): RunnerTarget | null {
    if (!wanted) return targets[0] ?? null
    const needle = wanted.toLowerCase()
    return targets.find(target => target.id === wanted || target.name.toLowerCase() === needle) ?? null
}

export function revokeRunnerCredential(dataDir: string, id: string): boolean {
    const data = load(dataDir)
    const before = data.credentials.length
    data.credentials = data.credentials.filter(credential => credential.id !== id)
    if (data.credentials.length === before) return false
    save(dataDir, data)
    return true
}

export function runnerCredentialByToken(dataDir: string, token: string): RunnerCredential | null {
    const data = load(dataDir)
    const hash = hashToken(token)
    const credential = data.credentials.find(entry => entry.tokenHash === hash)
    if (!credential) return null
    credential.lastUsedAtMs = Date.now()
    save(dataDir, data)
    return credential
}

export function credentialsFileExists(dataDir: string): boolean {
    return existsSync(filePath(dataDir))
}
