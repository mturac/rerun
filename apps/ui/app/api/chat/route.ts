import { actorFromContext, callableEngineAgentIds } from '@/app/api/_auth/access'
import { requireWorkspaceContext } from '@/app/api/_auth/ownership'
import { createSessionRow, ensureSessionRow, getAgentChatTarget, getExistingSession, projectChatAdmission } from '@/app/api/_services/chat.service'
import { messageAuthorOf } from '@/app/api/_services/me.service'
import { recordSessionParticipant, recordSessionRead } from '@/app/api/_services/notification-audience.service'
import type { Database } from '@/app/api/database.types'
import { generateSessionTitle } from '@/lib/ai/generate-title'
import { QUEUED_RETRY_DELAYS_MS, startChat } from '@/lib/chat/start-chat'
import { stripAttachmentsRef } from '@/lib/chat/attachments-marker'
import { installSessionTitle, parseInstallMessage } from '@/lib/chat/install-marker'
import { preferredLanguage } from '@/lib/foreman/language'
import { stripVoiceMarker } from '@/lib/voice/marker'
import { createServiceRoleClient } from '@/supabase/serviceRole'
import { ENGINE_SESSION_NOT_FOUND, SESSION_NOT_FOUND, type MessageAuthor, type SessionSource } from '@rerun/contracts'

type ChatRequestBody = {
    agentId?: unknown
    sessionId?: string
    text?: unknown
    connectionId?: string
    model?: string
    source?: SessionSource
    queued?: boolean
}

// A code rather than the engine's sentence: the chat turns it into a notice that opens a new
// conversation, instead of a red box quoting the engine.
const sessionNotFound = () => Response.json({ error: SESSION_NOT_FOUND }, { status: 404 })

export async function POST(request: Request) {
    // Reject unauthenticated callers up front. getAgentChatTarget below also
    // enforces that the agent belongs to this workspace (defense in depth).
    let workspaceId: number
    let author: MessageAuthor
    let callablePromise: Promise<string[] | undefined>
    try {
        const ctx = await requireWorkspaceContext()
        workspaceId = ctx.workspace.id
        author = messageAuthorOf(ctx)
        // Read alongside the body and awaited inside the engine call's try: a failure fails the send
        // rather than letting it through with every coworker callable.
        callablePromise = callableEngineAgentIds(actorFromContext(ctx))
        callablePromise.catch(() => {})
    } catch {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // A malformed body is not exceptional here: the Next proxy truncates anything over its
    // 10MB cap, and an unhandled parse error would answer 500 with an empty body, which the
    // AI SDK turns into an Error with no message at all.
    let body: ChatRequestBody
    try {
        body = await request.json()
    } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { agentId, sessionId, connectionId, model, source, queued } = body

    if (typeof agentId !== 'string') {
        return Response.json({ error: 'Missing coworker id' }, { status: 400 })
    }

    const text = typeof body.text === 'string' ? body.text : ''

    if (!text) {
        return Response.json({ error: 'Missing message text' }, { status: 400 })
    }

    const target = await getAgentChatTarget(agentId).catch(() => null)
    if (!target) {
        return Response.json({ error: 'Coworker not configured or not found' }, { status: 400 })
    }

    // Resolve the engine session id for an existing conversation.
    let engineSessionId: string | undefined
    if (sessionId) {
        let existing: Awaited<ReturnType<typeof getExistingSession>>
        try {
            existing = await getExistingSession(sessionId)
        } catch {
            return Response.json({ error: 'Failed to resolve session' }, { status: 500 })
        }
        // A tab of one coworker holding another one's conversation: the engine would answer with a
        // raw 404, since the session lives in the other coworker's database.
        if (existing.agentId !== agentId) {
            console.warn(`[CHAT SESSION MISMATCH] agent=${agentId} session=${sessionId} owner=${existing.agentId}`)
            return sessionNotFound()
        }
        engineSessionId = existing.engineSessionId ?? undefined
    }

    // A voice message carries its audio as a marker appended to the transcript; the session title
    // is about what was said, not about the file. An install is named after the setup it starts,
    // never after a summary of its guide.
    const install = parseInstallMessage(text)
    const sessionTitleSeed = install ? installSessionTitle(install.agentName) : stripVoiceMarker(stripAttachmentsRef(text))

    let engineRes: Response
    try {
        console.log(`[CHAT START] agent=${agentId} session=${sessionId ?? '(new)'} inputLength=${text.length}${queued ? ' queued' : ''}`)
        engineRes = await startChat(target.conn, target.engineAgentId, { sessionId: engineSessionId, message: text, connectionId, model, source, author, callableAgentIds: await callablePromise, install: !!install && !sessionId, userLanguage: install && !sessionId ? (preferredLanguage(request.headers.get('accept-language')) ?? undefined) : undefined }, queued ? QUEUED_RETRY_DELAYS_MS : null, request.signal)
    } catch (err) {
        return Response.json({ error: `Engine error: ${err instanceof Error ? err.message : 'Failed to start chat'}` }, { status: 502 })
    }

    // A shared author does not identify a message. Return busy sends so the client can preserve
    // their text, even when the same person started the run from another tab.
    if (engineRes.status === 409) {
        const busy = (await engineRes.json().catch(() => null)) as { code?: string; sessionId?: string; runId?: string; startedAt?: string | null; authorId?: string | null } | null
        // The agent's install already runs in another conversation: the chat opens that one rather
        // than a second install. Its row is mirrored here in case the run that opened it never got
        // that far.
        if (busy?.code === 'install_in_flight' && busy.sessionId && install) {
            const installSessionId = await ensureSessionRow(agentId, busy.sessionId, sessionTitleSeed, { source })
            return Response.json({ error: 'install_in_flight', sessionId: installSessionId }, { status: 409 })
        }
        console.warn(`[CHAT BUSY] agent=${agentId} session=${sessionId ?? '(new)'} run=${busy?.runId ?? '?'} input=${JSON.stringify(text.slice(0, 200))}`)
        const heldByTeammate = Boolean(busy?.authorId) && busy?.authorId !== author.id
        return Response.json({ error: 'run_in_flight', runId: busy?.runId ?? null, startedAt: busy?.startedAt ?? null, heldByTeammate }, { status: 409 })
    }

    if (!engineRes.ok || !engineRes.body) {
        const errBody = await engineRes.text().catch(() => '')
        if (engineRes.status === 404 && errBody.includes(ENGINE_SESSION_NOT_FOUND)) {
            console.warn(`[CHAT SESSION GONE] agent=${agentId} session=${sessionId ?? '(new)'} engineSession=${engineSessionId ?? '?'}`)
            return sessionNotFound()
        }
        return Response.json({ error: `Engine error: ${engineRes.status} ${errBody}` }, { status: 502 })
    }

    // The engine returns the (possibly newly created) session id as a header.
    const resolvedEngineSessionId = engineRes.headers.get('x-session-id') ?? engineSessionId

    // Map to the Supabase session row the UI tracks.
    let supabaseSessionId = sessionId
    if (!supabaseSessionId) {
        if (!resolvedEngineSessionId) {
            return Response.json({ error: 'Engine did not return a session id' }, { status: 502 })
        }
        try {
            supabaseSessionId = await createSessionRow(agentId, resolvedEngineSessionId, sessionTitleSeed, null, source)
        } catch {
            return Response.json({ error: 'Failed to persist session' }, { status: 500 })
        }
        if (!install) {
            generateSessionTitle(sessionTitleSeed)
                .then(async title => {
                    const supabase = createServiceRoleClient()
                    await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ title }).eq('id', supabaseSessionId!)
                })
                .catch(() => {})
        }
    } else if (resolvedEngineSessionId && resolvedEngineSessionId !== engineSessionId) {
        // Backfill the engine session id if we didn't have it yet.
        const supabase = createServiceRoleClient()
        await supabase.from('sessions').update<Database['public']['Tables']['sessions']['Update']>({ engine_session_id: resolvedEngineSessionId }).eq('id', supabaseSessionId).then()
    }

    if (!resolvedEngineSessionId) return Response.json({ error: 'Engine did not return a session id' }, { status: 502 })
    try { await projectChatAdmission(workspaceId, agentId, target.engineAgentId, resolvedEngineSessionId, engineRes) } catch { return Response.json({ error: 'Invalid engine execution' }, { status: 502 }) }
    await Promise.all([recordSessionParticipant(supabaseSessionId, author.id), recordSessionRead(supabaseSessionId, author.id)])

    const headers = new Headers()
    headers.set('Content-Type', engineRes.headers.get('content-type') ?? 'text/event-stream')
    headers.set('x-vercel-ai-ui-message-stream', engineRes.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1')
    headers.set('X-Session-Id', supabaseSessionId)
    const runId = engineRes.headers.get('x-run-id')
    if (runId) headers.set('X-Run-Id', runId)

    return new Response(engineRes.body, { headers })
}
