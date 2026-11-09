import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { LocalRunnerStore } from './store.js'
import { APPROVAL_TEXT_LIMIT, type RunnerMode, type RunnerTask } from './types.js'

// Never/Ask/Always plus the optional team repo allowlist. With no allowlist configured every
// subject is allowed; a non-empty list only lets listed subjects run tasks.
//
// Subjects and allowlist entries may be namespaced as `repo:<ref>`, `path:<pattern>` or
// `cmd:<pattern>`. Bare strings are treated as `repo:` for backward compatibility: existing
// `--allow team/app` entries and caller-supplied subjects keep working. Repo refs are matched
// by canonical key (host/owner/repo), so `repo:https://github.com/team/app.git`,
// `repo:git@github.com:team/app.git` and `repo:github.com/team/app` are equivalent, and a bare
// `team/app` also matches `github.com/team/app` on any host. `path:`/`cmd:` entries match only
// same-kind subjects, exactly or by trailing `*` prefix. To get repo entries verified against
// the runner's actual git remote, pass the allowlist through `resolveAllowlist` at startup
// (the CLI does this); unverified `repo:` entries are dropped with a warning.

export type SubjectKind = 'repo' | 'path' | 'cmd'

const SUBJECT_KINDS = new Set<string>(['repo', 'path', 'cmd'])

export function parseSubject(subject: string): { kind: SubjectKind; value: string } {
    const idx = subject.indexOf(':')
    if (idx > 0) {
        const prefix = subject.slice(0, idx)
        if (SUBJECT_KINDS.has(prefix)) return { kind: prefix as SubjectKind, value: subject.slice(idx + 1) }
    }
    return { kind: 'repo', value: subject }
}

export function canonicalRepoKey(value: string): string | null {
    let v = value.trim().replace(/\/+$/, '')
    if (!v) return null
    v = v.replace(/\.git$/i, '')
    if (!v.includes('://')) {
        const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(v)
        if (scp) v = `${scp[1]}/${scp[2]}`
    } else {
        try {
            const url = new URL(v)
            v = `${url.host}${url.pathname}`
        } catch {
            return null
        }
    }
    v = v.replace(/^\/+/, '').replace(/\/+/g, '/').toLowerCase()
    return v || null
}

function repoKeys(value: string): Set<string> {
    const key = canonicalRepoKey(value)
    if (!key) return new Set([value])
    const out = new Set([key])
    const parts = key.split('/')
    if (parts.length > 2) out.add(parts.slice(-2).join('/'))
    return out
}

function repoValueMatches(entry: string, subject: string): boolean {
    if (entry.endsWith('*')) {
        const rawPrefix = entry.slice(0, -1)
        if (subject.startsWith(rawPrefix)) return true
        const prefix = canonicalRepoKey(rawPrefix)
        const key = canonicalRepoKey(subject)
        if (!prefix || !key) return false
        const shortKey = key.split('/').slice(-2).join('/')
        return key === prefix || key.startsWith(`${prefix}/`) || shortKey === prefix || shortKey.startsWith(prefix)
    }
    const entryKeys = repoKeys(entry)
    for (const candidate of repoKeys(subject)) {
        if (entryKeys.has(candidate)) return true
    }
    return false
}

function subjectEntryMatches(entry: { kind: SubjectKind; value: string }, subject: { kind: SubjectKind; value: string }): boolean {
    if (entry.kind === 'repo') {
        return subject.kind === 'repo' && repoValueMatches(entry.value, subject.value)
    }
    if (entry.kind !== subject.kind) return false
    return entry.value.endsWith('*') ? subject.value.startsWith(entry.value.slice(0, -1)) : entry.value === subject.value
}

export function allowlistAllows(allowlist: string[] | undefined, subject: string | undefined): boolean {
    if (!allowlist || allowlist.length === 0) return true
    if (!subject) return false
    const parsed = parseSubject(subject)
    return allowlist.some(entry => subjectEntryMatches(parseSubject(entry), parsed))
}

export type AllowlistResolution = { entries: string[]; warnings: string[] }

// Matches nothing; used when every configured entry failed verification so a non-empty
// allowlist can never collapse into the "no allowlist" allow-all case.
const NEVER_MATCH = 'path:\u0000'

function git(rootDir: string, args: string[]): string | null {
    try {
        return execFileSync('git', ['-C', rootDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    } catch {
        return null
    }
}

function gitRemoteKeys(rootDir: string): Set<string> {
    const keys = new Set<string>()
    const remotes = git(rootDir, ['remote'])
    if (!remotes) return keys
    for (const name of remotes.split('\n').map(entry => entry.trim()).filter(Boolean)) {
        const url = git(rootDir, ['remote', 'get-url', name])
        const key = url ? canonicalRepoKey(url) : null
        if (!key) continue
        keys.add(key)
        const parts = key.split('/')
        if (parts.length > 2) keys.add(parts.slice(-2).join('/'))
    }
    return keys
}

function safeRealpath(path: string): string | null {
    try {
        return realpathSync(path)
    } catch {
        return null
    }
}

function isPathLike(value: string): boolean {
    return value === '.' || value === '..' || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~') || isAbsolute(value)
}

function repoEntryVerified(value: string, remoteKeys: Set<string>, verifiedRoots: Set<string>, rootDir: string): boolean {
    if (value.endsWith('*')) {
        const prefix = canonicalRepoKey(value.slice(0, -1))
        if (!prefix) return true
        for (const key of remoteKeys) {
            if (key.startsWith(prefix)) return true
        }
        return false
    }
    if (isPathLike(value)) {
        const expanded = value.startsWith('~') ? `${homedir()}${value.slice(1)}` : value
        const real = safeRealpath(isAbsolute(expanded) ? expanded : resolve(rootDir, expanded))
        return real !== null && verifiedRoots.has(real)
    }
    for (const candidate of repoKeys(value)) {
        if (remoteKeys.has(candidate)) return true
    }
    return false
}

// Verifies explicitly `repo:`-prefixed allowlist entries against the git remotes and toplevel
// of rootDir. Entries that cannot be tied to an actual remote (or, for path-like refs, to
// rootDir's real path) are dropped with a warning; `path:`/`cmd:` entries and bare legacy
// entries pass through unchanged — prefix with `repo:` to get git verification. Call once at
// startup before handing the list to createLocalRunnerApp.
export function resolveAllowlist(allowlist: string[] | undefined, rootDir: string): AllowlistResolution {
    if (!allowlist || allowlist.length === 0) return { entries: [], warnings: [] }
    const needsGit = allowlist.some(entry => entry.startsWith('repo:'))
    const remoteKeys = needsGit ? gitRemoteKeys(rootDir) : new Set<string>()
    const verifiedRoots = new Set<string>()
    if (needsGit) {
        const topLevel = git(rootDir, ['rev-parse', '--show-toplevel'])
        if (topLevel) {
            const real = safeRealpath(topLevel)
            if (real) verifiedRoots.add(real)
        }
        const rootReal = safeRealpath(rootDir)
        if (rootReal) verifiedRoots.add(rootReal)
    }

    const warnings: string[] = []
    const entries: string[] = []
    for (const raw of allowlist) {
        if (!raw.startsWith('repo:')) {
            entries.push(raw)
            continue
        }
        const parsed = parseSubject(raw)
        if (repoEntryVerified(parsed.value, remoteKeys, verifiedRoots, rootDir)) {
            entries.push(raw)
        } else {
            warnings.push(`allowlist entry '${raw}' does not match this runner's git remote or root; ignoring`)
        }
    }
    if (entries.length === 0) entries.push(NEVER_MATCH)
    return { entries, warnings }
}

export type PermissionDecision =
    | { kind: 'allow'; via: 'grant' | 'mode' }
    | { kind: 'deny'; reason: 'mode-never' | 'denied-before' | 'allowlist' }
    | { kind: 'ask' }

export function defaultTaskKey(task: RunnerTask): string {
    const basis = [task.kind, task.subject ?? '', task.command ?? task.path ?? ''].join('\n')
    return createHash('sha256').update(basis).digest('hex').slice(0, 24)
}

export function grantAction(task: RunnerTask): string {
    return task.kind === 'shell' ? `shell:${task.command ?? ''}` : task.kind
}

export function decidePermission(input: {
    mode: RunnerMode
    store: LocalRunnerStore
    subject?: string
    kind: RunnerTask['kind']
    action: string
    taskKey: string
    allowlist?: string[]
}): PermissionDecision {
    if (!allowlistAllows(input.allowlist, input.subject)) return { kind: 'deny', reason: 'allowlist' }
    if (input.store.hasDenial(input.taskKey)) return { kind: 'deny', reason: 'denied-before' }
    // A grant on the exact action wins; a kind-level grant ('shell', 'file.read') covers the rest.
    const grant = input.store.findGrant(input.subject, input.action) ?? input.store.findGrant(input.subject, input.kind)
    if (grant) return { kind: 'allow', via: 'grant' }
    if (input.mode === 'never') return { kind: 'deny', reason: 'mode-never' }
    if (input.mode === 'always') return { kind: 'allow', via: 'mode' }
    return { kind: 'ask' }
}

export function approvalText(task: RunnerTask): string {
    const explicit = task.approvalText?.trim()
    const described =
        explicit ??
        (task.kind === 'shell'
            ? `Run shell command: ${task.command ?? ''}`
            : task.kind === 'file.write'
              ? `Write file ${task.path ?? ''} (${task.content?.length ?? 0} chars)`
              : `Read file ${task.path ?? ''}`)
    if (described.length <= APPROVAL_TEXT_LIMIT) return described
    return `${described.slice(0, APPROVAL_TEXT_LIMIT - 1)}…`
}
