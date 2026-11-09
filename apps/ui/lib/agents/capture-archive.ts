import type { AgentArchivePlan, AgentImportResult } from '@rerun/contracts'
import { fetchAgentArchive, planAgentArchive } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'

// The runtime half of archiving an agent, with no idea what will receive the bytes. A template
// capture and a share link both go through here; only what they write afterwards differs.

// An engine that predates the archive routes answers 404 to a perfectly valid request, and
// "not found" reads as "the agent is gone" rather than "this box is behind".
export const STALE_EXPORT_HINT = 'This workspace runs on a machine whose engine is too old to export coworkers. Ask the Rerun team to update it, then try again.'
export const STALE_IMPORT_HINT = 'This workspace runs on a machine whose engine is too old to import coworkers. Ask the Rerun team to update it, then try again.'

// The engine caps an import body at ARCHIVE_LIMITS.maxTotalBytes (150 MB) on its own stream; this
// mirrors that ceiling so an oversized file is refused before the upload even starts.
export const ARCHIVE_IMPORT_MAX_BYTES = 150 * 1024 * 1024
export const ARCHIVE_IMPORT_MAX_MB = ARCHIVE_IMPORT_MAX_BYTES / (1024 * 1024)

export function isMissingRoute(err: unknown): boolean {
    return err instanceof Error && /failed: 404/.test(err.message)
}

export type CapturedArchive = { plan: AgentArchivePlan; bytes: Uint8Array }

// The plan is re-taken with the exclusions applied, so it describes the archive that is actually
// built rather than the folder it came from.
export async function captureAgentArchive(conn: EngineConnection, engineAgentId: string, exclude: string[]): Promise<CapturedArchive> {
    let plan: AgentArchivePlan
    try {
        plan = await planAgentArchive(conn, engineAgentId, exclude)
    } catch (err) {
        throw isMissingRoute(err) ? new Error(STALE_EXPORT_HINT) : err
    }

    const response = await fetchAgentArchive(conn, engineAgentId, exclude)
    if (!response.ok) throw new Error(`Failed to export "${plan.name}": ${response.status} ${await response.text().catch(() => '')}`)

    return { plan, bytes: new Uint8Array(await response.arrayBuffer()) }
}

// The two things nobody can see for themselves once the tarball is closed: what the archive
// rewrote on its way out, and the fact that a webhook does not travel with its address.
export function archiveWarnings(plan: AgentArchivePlan, label: string): string[] {
    const warnings: string[] = []
    if (plan.strippedConfigKeys.length > 0) {
        warnings.push(`"${label}": ${plan.strippedConfigKeys.length} literal credential(s) were stripped from config.json (${plan.strippedConfigKeys.join(', ')}).`)
    }
    if (plan.triggers.length > 0) {
        warnings.push(`"${label}": ${plan.triggers.length} webhook(s) travel, each issued its own URL on install (${plan.triggers.map(trigger => trigger.name).join(', ')}). Whoever installs this has to point their service at the new address.`)
    }
    return warnings
}

export function importedArchiveWarnings(result: AgentImportResult): string[] {
    const warnings: string[] = []
    if (result.skippedPaths.length > 0) {
        warnings.push(`${result.skippedPaths.length} file(s) in the archive were refused (${result.skippedPaths.slice(0, 3).join(', ')}).`)
    }
    if (result.triggers.length > 0) {
        warnings.push(`${result.triggers.length} webhook(s) were created with a new URL each (${result.triggers.join(', ')}). Read them in the coworker panel and point your services at them.`)
    }
    if (result.envKeys.length > 0) {
        warnings.push(`${result.envKeys.length} API key(s) have to be filled in again before it can run.`)
    }
    return warnings
}
