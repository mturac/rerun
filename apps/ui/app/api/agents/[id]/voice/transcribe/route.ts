import { AuthorizationError, UnauthenticatedError } from '@/app/api/_auth/ownership'
import { resolveRunTarget } from '@/app/api/_services/chat.service'
import { EngineRequestError, transcribeAgentVoice } from '@/lib/engine/client'
import { NoEngineError } from '@/app/api/_services/workspace-engine.service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// The middleware tees request bodies and truncates them at 10 MB; a 30 s dictation at
// 32 kbps is ~120 KB, so anything near the cap is not a recording.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const FORMAT_PATTERN = /^[a-z0-9]{1,8}$/

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params

    const format = new URL(request.url).searchParams.get('format') ?? ''
    if (!FORMAT_PATTERN.test(format)) return Response.json({ error: 'Unsupported audio format' }, { status: 400 })

    const audio = await request.arrayBuffer()
    if (audio.byteLength === 0) return Response.json({ error: 'Empty recording' }, { status: 400 })
    if (audio.byteLength > MAX_AUDIO_BYTES) return Response.json({ error: 'Recording too large' }, { status: 413 })

    let target: Awaited<ReturnType<typeof resolveRunTarget>>
    try {
        target = await resolveRunTarget(id)
    } catch (err) {
        if (err instanceof UnauthenticatedError) return Response.json({ error: 'Unauthorized' }, { status: 401 })
        if (err instanceof AuthorizationError) return Response.json({ error: 'Coworker not found' }, { status: 404 })
        if (err instanceof NoEngineError) return Response.json({ error: 'No machine connected' }, { status: 409 })
        return Response.json({ error: err instanceof Error ? err.message : 'Unauthorized' }, { status: 401 })
    }

    try {
        const text = await transcribeAgentVoice(target.conn, target.engineAgentId, audio, format)
        return Response.json({ text })
    } catch (err) {
        if (err instanceof EngineRequestError) {
            const status = err.status >= 400 && err.status < 600 ? err.status : 502
            return Response.json({ error: err.message }, { status })
        }
        return Response.json({ error: err instanceof Error ? err.message : 'Engine unreachable' }, { status: 502 })
    }
}
