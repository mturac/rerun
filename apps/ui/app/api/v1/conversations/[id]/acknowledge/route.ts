import { assertSessionInWorkspace } from '@/app/api/_auth/access'
import { readSessionObservation } from '@/app/api/_services/chat.service'
import { acknowledgeSessionExecution } from '@/app/api/_services/session-execution.service'
import { apiRoute } from '@/app/api/v1/_lib/api-route'

export const dynamic = 'force-dynamic'

export const POST = apiRoute({ auth: 'member' }, async ({ params, ctx }) => {
    await assertSessionInWorkspace(params.id)
    const observation = await readSessionObservation(params.id)
    if (observation) await acknowledgeSessionExecution(ctx.workspace.id, params.id, observation)
})
