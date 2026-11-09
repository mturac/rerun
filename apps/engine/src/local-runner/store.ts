import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PendingApproval } from './types.js'

// Scope'd persistent grants (subject + action) and the per-task denial memory, in one versioned
// JSON file under the runner's data dir. A denial for a taskKey suppresses future asks for it.

export type GrantEntry = { subject: string; action: string; grantedAtMs: number }
export type DenialEntry = { taskKey: string; deniedAtMs: number; reason: string }

type StoreFile = { version: 1; grants: GrantEntry[]; denials: DenialEntry[] }

const STORE_FILE = 'grants.json'
const EMPTY: StoreFile = { version: 1, grants: [], denials: [] }

export class LocalRunnerStore {
    private readonly file: string
    private data: StoreFile

    constructor(dataDir: string) {
        this.file = join(dataDir, 'local-runner', STORE_FILE)
        this.data = this.load()
    }

    private load(): StoreFile {
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreFile>
            if (parsed.version !== 1 || !Array.isArray(parsed.grants) || !Array.isArray(parsed.denials)) return { ...EMPTY, grants: [], denials: [] }
            return { version: 1, grants: parsed.grants, denials: parsed.denials }
        } catch {
            return { version: 1, grants: [], denials: [] }
        }
    }

    private save(): void {
        mkdirSync(dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
        renameSync(tmp, this.file)
    }

    findGrant(subject: string | undefined, action: string): GrantEntry | undefined {
        const wanted = subject ?? ''
        return this.data.grants.find(grant => grant.action === action && (grant.subject === '*' || grant.subject === wanted))
    }

    hasDenial(taskKey: string): DenialEntry | undefined {
        return this.data.denials.find(denial => denial.taskKey === taskKey)
    }

    addGrant(subject: string | undefined, action: string): GrantEntry {
        const existing = this.findGrant(subject, action)
        if (existing) return existing
        const grant: GrantEntry = { subject: subject ?? '*', action, grantedAtMs: Date.now() }
        this.data.grants.push(grant)
        this.save()
        return grant
    }

    addDenial(taskKey: string, reason: string): void {
        this.data.denials = this.data.denials.filter(denial => denial.taskKey !== taskKey)
        this.data.denials.push({ taskKey, deniedAtMs: Date.now(), reason })
        this.save()
    }

    clearDenial(taskKey?: string): number {
        const before = this.data.denials.length
        this.data.denials = taskKey === undefined ? [] : this.data.denials.filter(denial => denial.taskKey !== taskKey)
        if (this.data.denials.length !== before) this.save()
        return before - this.data.denials.length
    }

    clearGrants(subject?: string, action?: string): number {
        const before = this.data.grants.length
        this.data.grants = this.data.grants.filter(grant => {
            if (subject !== undefined && grant.subject !== subject && grant.subject !== '*') return true
            if (action !== undefined && grant.action !== action) return true
            return false
        })
        if (this.data.grants.length !== before) this.save()
        return before - this.data.grants.length
    }

    listGrants(): GrantEntry[] {
        return [...this.data.grants]
    }

    listDenials(): DenialEntry[] {
        return [...this.data.denials]
    }

    static fileExists(dataDir: string): boolean {
        return existsSync(join(dataDir, 'local-runner', STORE_FILE))
    }
}

// Ask-mode pendings in a sibling versioned file: they churn on every gated task and expire on
// their own TTL, so they stay out of grants.json. Expired entries are dropped on load and on
// every list, which keeps the file from growing across restarts.
type ApprovalsFile = { version: 1; pendings: PendingApproval[] }

const APPROVALS_FILE = 'approvals.json'
const EMPTY_APPROVALS: ApprovalsFile = { version: 1, pendings: [] }

function isPendingApproval(value: unknown): value is PendingApproval {
    if (typeof value !== 'object' || value === null) return false
    const pending = value as Partial<PendingApproval>
    return typeof pending.id === 'string' && typeof pending.expiresAtMs === 'number' && typeof pending.taskKey === 'string' && typeof pending.task === 'object' && pending.task !== null
}

export class LocalRunnerApprovals {
    private readonly file: string
    private data: ApprovalsFile

    constructor(dataDir: string) {
        this.file = join(dataDir, 'local-runner', APPROVALS_FILE)
        this.data = this.load()
        if (this.prune(Date.now())) this.save()
    }

    private load(): ApprovalsFile {
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ApprovalsFile>
            if (parsed.version !== 1 || !Array.isArray(parsed.pendings)) return { ...EMPTY_APPROVALS, pendings: [] }
            return { version: 1, pendings: parsed.pendings.filter(isPendingApproval) }
        } catch {
            return { version: 1, pendings: [] }
        }
    }

    private save(): void {
        mkdirSync(dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
        renameSync(tmp, this.file)
    }

    private prune(nowMs: number): boolean {
        const before = this.data.pendings.length
        this.data.pendings = this.data.pendings.filter(pending => pending.expiresAtMs > nowMs)
        return this.data.pendings.length !== before
    }

    put(pending: PendingApproval): void {
        this.data.pendings = this.data.pendings.filter(existing => existing.id !== pending.id)
        this.data.pendings.push(pending)
        this.save()
    }

    take(id: string): PendingApproval | undefined {
        const pending = this.data.pendings.find(existing => existing.id === id)
        if (!pending) return undefined
        this.data.pendings = this.data.pendings.filter(existing => existing.id !== id)
        this.save()
        return pending
    }

    list(nowMs: number = Date.now()): PendingApproval[] {
        if (this.prune(nowMs)) this.save()
        return [...this.data.pendings]
    }

    static fileExists(dataDir: string): boolean {
        return existsSync(join(dataDir, 'local-runner', APPROVALS_FILE))
    }
}
