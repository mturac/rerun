import { assertAgentInWorkspace } from '@/app/api/_auth/access'
import { AuthorizationError } from '@/app/api/_auth/ownership'
import { resolveAgentTarget } from '@/app/api/_services/chat.service'
import { EngineRequestError, getExternalAgentTask } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; provider: string; taskId: string }> }): Promise<Response> {
    const { id, provider, taskId } = await params
    try {
        await assertAgentInWorkspace(id)
    } catch (err) {
        return err instanceof AuthorizationError ? Response.json({ error: err.message }, { status: 404 }) : Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    try {
        const { conn, engineAgentId } = await resolveAgentTarget(id)
        const task = await getExternalAgentTask(conn, engineAgentId, provider, taskId)
        if (!task) return Response.json({ error: 'Unknown external agent task' }, { status: 404 })
        return Response.json({ task })
    } catch (err) {
        if (err instanceof EngineRequestError && err.status === 404) return Response.json({ error: 'Unknown external agent task' }, { status: 404 })
        return Response.json({ error: err instanceof Error ? err.message : 'Engine unreachable' }, { status: 502 })
    }
}
