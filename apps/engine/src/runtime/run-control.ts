type RunHandle = { controller: AbortController; agentId: string } & (
    | { phase: 'running'; cancel?: () => void }
    | { phase: 'cancelling' }
)

const controllers = new Map<string, RunHandle>()

// One live run per conversation. Two runs on the same session read the same history before
// either has written its user message, so they answer past each other and interleave their
// messages into one transcript. Claimed synchronously, before the run row is even inserted,
// so a duplicate request cannot slip through the await.
type SessionClaim = { runId: string; claimedAt: number; authorId?: string }

const sessionClaims = new Map<string, SessionClaim>()
const claimedSessions = new Map<string, string>()
const pendingStops = new Set<string>()

export function registerRunAbort(runId: string, agentId: string): AbortController {
    const controller = new AbortController()
    const phase = pendingStops.has(runId) ? 'cancelling' : 'running'
    controllers.set(runId, { phase, controller, agentId })
    if (phase === 'cancelling') controller.abort()
    return controller
}

// The abort signal alone is not enough to stop a hung run: the codex provider ignores it until its
// turn has actually started, which is exactly the case when an expired token wedges the handshake.
// The run loop registers here what it takes to really close itself down.
export function setRunCancel(runId: string, cancel: () => void): void {
    const handle = controllers.get(runId)
    if (handle?.phase === 'running') handle.cancel = cancel
    else if (handle?.phase === 'cancelling' && pendingStops.delete(runId)) cancel()
}

export function unregisterRunAbort(runId: string): void {
    controllers.delete(runId)
    releaseSession(runId)
}

export function claimSession(sessionId: string, runId: string, authorId?: string): string | null {
    const holder = sessionClaims.get(sessionId)
    if (holder) return holder.runId
    sessionClaims.set(sessionId, { runId, claimedAt: Date.now(), authorId })
    claimedSessions.set(runId, sessionId)
    return null
}

export function sessionClaim(sessionId: string): SessionClaim | null {
    return sessionClaims.get(sessionId) ?? null
}

export function releaseSession(runId: string): void {
    pendingStops.delete(runId)
    const sessionId = claimedSessions.get(runId)
    if (!sessionId) return
    claimedSessions.delete(runId)
    if (sessionClaims.get(sessionId)?.runId === runId) sessionClaims.delete(sessionId)
}

export function agentHasLiveRun(agentId: string): boolean {
    for (const handle of controllers.values()) if (handle.agentId === agentId) return true
    return false
}

export function activeRunCount(): number {
    return controllers.size
}

export function sessionClaimCount(): number {
    return sessionClaims.size
}

export function abortRun(runId: string): boolean {
    const handle = controllers.get(runId)
    if (!handle) {
        // Chat claims its session before awaiting the run row. A stop in that gap belongs to
        // the upcoming loop, whose cancel hook will announce completion after registration.
        if (!claimedSessions.has(runId)) return false
        pendingStops.add(runId)
        return true
    }
    if (handle.phase === 'cancelling') return true
    const cancel = handle.cancel
    if (cancel) {
        // Settlement owns the claim until its final transcript writes and teardown finish.
        controllers.set(runId, { phase: 'cancelling', controller: handle.controller, agentId: handle.agentId })
    } else {
        unregisterRunAbort(runId)
    }
    handle.controller.abort()
    // Closes the run for good: writes its terminal row, tells the hub, and tears the provider
    // process down. Without it a provider that ignores the abort keeps the conversation "working".
    cancel?.()
    return true
}
