import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowlistAllows, approvalText, canonicalRepoKey, decidePermission, defaultTaskKey, parseSubject, resolveAllowlist } from './permissions.js'
import { LocalRunnerStore } from './store.js'
import type { RunnerTask } from './types.js'

function setup(mode: 'never' | 'ask' | 'always' = 'ask', allowlist?: string[]) {
    const store = new LocalRunnerStore(mkdtempSync(join(tmpdir(), 'rerun-lr-perm-')))
    const decide = (task: Partial<RunnerTask> & Pick<RunnerTask, 'kind'>, taskKey = 'k1') =>
        decidePermission({
            mode,
            store,
            subject: task.subject,
            kind: task.kind,
            action: task.kind === 'shell' ? `shell:${task.command ?? ''}` : task.kind,
            taskKey,
            allowlist,
        })
    return { store, decide }
}

describe('allowlistAllows', () => {
    it('is off by default: undefined or empty list allows every subject', () => {
        expect(allowlistAllows(undefined, 'anything')).toBe(true)
        expect(allowlistAllows([], 'anything')).toBe(true)
        expect(allowlistAllows(undefined, undefined)).toBe(true)
    })

    it('admits only listed subjects once configured', () => {
        const list = ['team/app', 'team/infra*']
        expect(allowlistAllows(list, 'team/app')).toBe(true)
        expect(allowlistAllows(list, 'team/infra-api')).toBe(true)
        expect(allowlistAllows(list, 'team/other')).toBe(false)
        expect(allowlistAllows(list, undefined)).toBe(false)
    })
})

describe('namespaced subjects', () => {
    it('parseSubject strips known prefixes and treats bare strings as repo', () => {
        expect(parseSubject('repo:github.com/a/b')).toEqual({ kind: 'repo', value: 'github.com/a/b' })
        expect(parseSubject('path:/tmp/x')).toEqual({ kind: 'path', value: '/tmp/x' })
        expect(parseSubject('cmd:rm *')).toEqual({ kind: 'cmd', value: 'rm *' })
        expect(parseSubject('team/app')).toEqual({ kind: 'repo', value: 'team/app' })
        expect(parseSubject('C:\\repo')).toEqual({ kind: 'repo', value: 'C:\\repo' })
    })

    it('canonicalRepoKey normalizes https, ssh, scp-like and shorthand refs', () => {
        expect(canonicalRepoKey('https://github.com/Team/App.git')).toBe('github.com/team/app')
        expect(canonicalRepoKey('git@github.com:Team/App.git')).toBe('github.com/team/app')
        expect(canonicalRepoKey('ssh://git@github.com/team/app')).toBe('github.com/team/app')
        expect(canonicalRepoKey('github.com/team/app/')).toBe('github.com/team/app')
        expect(canonicalRepoKey('team/app')).toBe('team/app')
        expect(canonicalRepoKey('')).toBeNull()
    })

    it('matches repo subjects across URL spellings and bare shorthand', () => {
        const list = ['repo:https://github.com/team/app.git']
        expect(allowlistAllows(list, 'repo:git@github.com:team/app.git')).toBe(true)
        expect(allowlistAllows(list, 'repo:github.com/team/app')).toBe(true)
        expect(allowlistAllows(list, 'team/app')).toBe(true)
        expect(allowlistAllows(list, 'repo:github.com/team/other')).toBe(false)
        expect(allowlistAllows(list, 'repo:gitlab.com/team/app')).toBe(true)
    })

    it('keeps path: and cmd: entries scoped to same-kind subjects', () => {
        expect(allowlistAllows(['path:src/*'], 'path:src/a.ts')).toBe(true)
        expect(allowlistAllows(['path:src/*'], 'path:docs/a.md')).toBe(false)
        expect(allowlistAllows(['path:src/*'], 'src/a.ts')).toBe(false)
        expect(allowlistAllows(['cmd:git *'], 'cmd:git status')).toBe(true)
        expect(allowlistAllows(['cmd:git *'], 'shell:git status')).toBe(false)
        expect(allowlistAllows(['cmd:git *'], 'git status')).toBe(false)
    })
})

describe('resolveAllowlist', () => {
    function gitRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), 'rerun-lr-git-'))
        execFileSync('git', ['init', '-q'], { cwd: dir })
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/team/app.git'], { cwd: dir })
        return dir
    }

    it('keeps repo entries that match a real remote and drops the rest with warnings', () => {
        const root = gitRepo()
        const resolved = resolveAllowlist(['repo:https://github.com/team/app', 'repo:other/repo', 'team/app', 'path:src/*'], root)
        expect(resolved.entries).toEqual(['repo:https://github.com/team/app', 'team/app', 'path:src/*'])
        expect(resolved.warnings).toHaveLength(1)
        expect(resolved.warnings[0]).toContain('repo:other/repo')
    })

    it('verifies repo:. style path refs against the runner root', () => {
        const root = gitRepo()
        const resolved = resolveAllowlist(['repo:.', 'repo:/nonexistent/deep/path'], root)
        expect(resolved.entries).toEqual(['repo:.'])
        expect(resolved.warnings).toHaveLength(1)
    })

    it('never collapses a fully rejected allowlist into allow-all', () => {
        const root = gitRepo()
        const resolved = resolveAllowlist(['repo:other/repo'], root)
        expect(resolved.entries).toHaveLength(1)
        expect(allowlistAllows(resolved.entries, 'repo:other/repo')).toBe(false)
        expect(allowlistAllows(resolved.entries, 'anything')).toBe(false)
    })

    it('returns empty for empty input and passes through when root is not a git repo', () => {
        expect(resolveAllowlist(undefined, '/tmp')).toEqual({ entries: [], warnings: [] })
        const plain = mkdtempSync(join(tmpdir(), 'rerun-lr-plain-'))
        const resolved = resolveAllowlist(['repo:team/app', 'path:a/*'], plain)
        expect(resolved.entries).toEqual(['path:a/*'])
        expect(resolved.warnings).toHaveLength(1)
    })
})

describe('decidePermission', () => {
    it('asks in ask mode with no grant or denial', () => {
        const { decide } = setup('ask')
        expect(decide({ kind: 'shell', command: 'ls' })).toEqual({ kind: 'ask' })
    })

    it('denies everything in never mode', () => {
        const { decide } = setup('never')
        expect(decide({ kind: 'shell', command: 'ls' })).toEqual({ kind: 'deny', reason: 'mode-never' })
    })

    it('allows in always mode', () => {
        const { decide } = setup('always')
        expect(decide({ kind: 'file.read', path: 'a.txt' })).toEqual({ kind: 'allow', via: 'mode' })
    })

    it('a stored grant allows even in ask mode', () => {
        const { store, decide } = setup('ask')
        store.addGrant('repo-a', 'file.read')
        expect(decide({ kind: 'file.read', path: 'a.txt', subject: 'repo-a' })).toEqual({ kind: 'allow', via: 'grant' })
        expect(decide({ kind: 'file.read', path: 'a.txt', subject: 'repo-b' })).toEqual({ kind: 'ask' })
    })

    it('a wildcard-subject grant covers every subject', () => {
        const { store, decide } = setup('ask')
        store.addGrant(undefined, 'file.read')
        expect(decide({ kind: 'file.read', path: 'a.txt', subject: 'repo-b' })).toEqual({ kind: 'allow', via: 'grant' })
    })

    it('kind-level shell grant covers commands without an exact grant', () => {
        const { store, decide } = setup('ask')
        store.addGrant('repo-a', 'shell')
        expect(decide({ kind: 'shell', command: 'rm -rf x', subject: 'repo-a' })).toEqual({ kind: 'allow', via: 'grant' })
    })

    it('denial memory suppresses asks for the same taskKey, even in always mode', () => {
        const { store, decide } = setup('always')
        store.addDenial('k1', 'denied by caller')
        expect(decide({ kind: 'shell', command: 'ls' })).toEqual({ kind: 'deny', reason: 'denied-before' })
    })

    it('allowlist denial wins over grants and modes', () => {
        const { store, decide } = setup('always', ['team/app'])
        store.addGrant('repo-a', 'shell')
        expect(decide({ kind: 'shell', command: 'ls', subject: 'repo-a' })).toEqual({ kind: 'deny', reason: 'allowlist' })
    })
})

describe('defaultTaskKey / approvalText', () => {
    it('derives a stable key from kind, subject and target', () => {
        const a = defaultTaskKey({ kind: 'shell', command: 'ls', subject: 'r' })
        const b = defaultTaskKey({ kind: 'shell', command: 'ls', subject: 'r' })
        const c = defaultTaskKey({ kind: 'shell', command: 'pwd', subject: 'r' })
        expect(a).toBe(b)
        expect(a).not.toBe(c)
    })

    it('caps approval text at 320 chars', () => {
        const long = `Run shell command: ${'x'.repeat(1000)}`
        const text = approvalText({ kind: 'shell', command: 'x'.repeat(1000) })
        expect(text.length).toBeLessThanOrEqual(320)
        expect(text.endsWith('…')).toBe(true)
        expect(long.length).toBeGreaterThan(320)
    })

    it('prefers explicit approvalText', () => {
        expect(approvalText({ kind: 'file.read', path: 'a', approvalText: '  read the secrets file  ' })).toBe('read the secrets file')
    })
})
