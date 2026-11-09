import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalRunnerApprovals, LocalRunnerStore } from './store.js'
import type { PendingApproval } from './types.js'

function tmpDataDir(): string {
    return mkdtempSync(join(tmpdir(), 'rerun-lr-store-'))
}

describe('LocalRunnerStore', () => {
    it('persists grants and denials across instances', () => {
        const dir = tmpDataDir()
        const store = new LocalRunnerStore(dir)
        store.addGrant('repo-a', 'shell:ls')
        store.addGrant(undefined, 'file.read')
        store.addDenial('task-1', 'denied by caller')

        const reloaded = new LocalRunnerStore(dir)
        expect(reloaded.findGrant('repo-a', 'shell:ls')?.subject).toBe('repo-a')
        expect(reloaded.findGrant('other', 'file.read')?.subject).toBe('*')
        expect(reloaded.findGrant('repo-a', 'file.write')).toBeUndefined()
        expect(reloaded.hasDenial('task-1')?.reason).toBe('denied by caller')
        expect(reloaded.hasDenial('task-2')).toBeUndefined()
    })

    it('does not duplicate grants and replaces denials per taskKey', () => {
        const dir = tmpDataDir()
        const store = new LocalRunnerStore(dir)
        store.addGrant('repo-a', 'shell')
        store.addGrant('repo-a', 'shell')
        store.addDenial('task-1', 'first')
        store.addDenial('task-1', 'second')
        expect(store.listGrants()).toHaveLength(1)
        expect(store.listDenials()).toHaveLength(1)
        expect(store.listDenials()[0]!.reason).toBe('second')
    })

    it('clears one or all denials', () => {
        const dir = tmpDataDir()
        const store = new LocalRunnerStore(dir)
        store.addDenial('a', 'x')
        store.addDenial('b', 'x')
        expect(store.clearDenial('a')).toBe(1)
        expect(store.hasDenial('a')).toBeUndefined()
        expect(store.hasDenial('b')).toBeDefined()
        expect(store.clearDenial()).toBe(1)
        expect(store.listDenials()).toHaveLength(0)
    })

    it('writes a versioned JSON file under local-runner/', () => {
        const dir = tmpDataDir()
        const store = new LocalRunnerStore(dir)
        store.addGrant('repo-a', 'shell')
        const raw = JSON.parse(readFileSync(join(dir, 'local-runner', 'grants.json'), 'utf8')) as { version: number; grants: unknown[] }
        expect(raw.version).toBe(1)
        expect(raw.grants).toHaveLength(1)
    })
})

function pending(id: string, expiresAtMs: number): PendingApproval {
    return { id, task: { kind: 'shell', command: 'ls' }, taskKey: `key-${id}`, action: 'shell:ls', text: 'Run shell command: ls', expiresAtMs }
}

describe('LocalRunnerApprovals', () => {
    it('persists pendings across instances and takes them once', () => {
        const dir = tmpDataDir()
        new LocalRunnerApprovals(dir).put(pending('p1', Date.now() + 60_000))

        const reloaded = new LocalRunnerApprovals(dir)
        expect(reloaded.list().map(entry => entry.id)).toEqual(['p1'])
        expect(reloaded.take('p1')?.taskKey).toBe('key-p1')
        expect(reloaded.list()).toHaveLength(0)
        expect(new LocalRunnerApprovals(dir).list()).toHaveLength(0)
    })

    it('prunes expired pendings on load and on read', () => {
        const dir = tmpDataDir()
        const store = new LocalRunnerApprovals(dir)
        store.put(pending('live', Date.now() + 60_000))
        store.put(pending('dead', Date.now() - 1))

        const reloaded = new LocalRunnerApprovals(dir)
        expect(reloaded.list().map(entry => entry.id)).toEqual(['live'])

        reloaded.put(pending('dying', Date.now() - 1))
        expect(reloaded.list().map(entry => entry.id)).toEqual(['live'])
    })

    it('writes a versioned JSON file under local-runner/', () => {
        const dir = tmpDataDir()
        new LocalRunnerApprovals(dir).put(pending('p1', Date.now() + 60_000))
        const raw = JSON.parse(readFileSync(join(dir, 'local-runner', 'approvals.json'), 'utf8')) as { version: number; pendings: unknown[] }
        expect(raw.version).toBe(1)
        expect(raw.pendings).toHaveLength(1)
    })
})
