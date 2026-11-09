import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { listAgentIndex } from '../db/repos/agents.js'
import { pendingExecutions, deferExecutionDelivery } from '../db/repos/execution.js'
import { systemDbExists } from '../db/systemDb.js'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { publishExecution } from './execution-events.js'

const POLL_MS = 5_000
const BATCH_LIMIT = 10

export async function flushExecutionDeliveries(agentIds: string[], now = Date.now(), limit = BATCH_LIMIT, stopped: () => boolean = () => false): Promise<number> {
    let attempts = 0
    for (const agentId of agentIds) {
        if (stopped() || attempts >= limit) break
        if (!systemDbExists(agentId)) continue
        for (const pending of await pendingExecutions(agentId, now, limit - attempts)) {
            if (stopped()) return attempts
            attempts++
            try {
                const result = await publishExecution(pending.execution)
                if (result.delivered || result.reason === 'superseded') continue
            } catch (error) {
                logger.warn({ agent: agentId, err: String(error) }, 'execution delivery retry failed')
            }
            await deferExecutionDelivery(pending.execution, pending.attempts, now)
            return attempts
        }
    }
    return attempts
}

export function startExecutionDelivery(flush?: () => Promise<void>): () => void {
    let stopped = false
    let offset = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
        try {
            if (flush) await flush()
            else {
                const { RERUN_HUB_BASE_URL: hub, RERUN_API_KEY: key } = env()
                if (hub && key) {
                    const agentIds = [...new Set([...(await listAgentIndex()).map(agent => agent.id), FOREMAN_AGENT_ID])]
                    const start = offset++ % agentIds.length
                    await flushExecutionDeliveries([...agentIds.slice(start), ...agentIds.slice(0, start)], Date.now(), BATCH_LIMIT, () => stopped)
                }
            }
        } catch (error) {
            logger.warn({ err: String(error) }, 'execution delivery poll failed')
        } finally {
            if (!stopped) timer = setTimeout(() => void tick(), POLL_MS).unref()
        }
    }
    timer = setTimeout(() => void tick(), 0).unref()
    return () => { stopped = true; clearTimeout(timer) }
}
