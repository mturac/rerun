import { streamText, type LanguageModelUsage, type ModelMessage, type StreamTextResult, type ToolSet, type UIMessageStreamWriter } from 'ai'
import { RERUN_CONNECTION_ID, contextTextPart, type ContextOccupancy, type MessageAuthor } from '@rerun/contracts'
import { applyCaching, withTailBreakpoint } from '../agents/caching.js'
import { mergeProviderOptions, reasoningProviderOptions } from '../agents/reasoning.js'
import { prepareRunHistory } from './compaction/compact.js'
import { repairToolPairs } from './compaction/repair.js'
import { approvalSummary, canonicalHitlName, findPendingHitl, hitlStepLacksMessage, hitlTurnIsOver, isHitlToolName, secretSummary, takeoverSummary, type PendingHitl } from '../tools/builtin/hitl.js'
import { CLI_PROVIDERS, resolveModel, type ModelOverride } from '../agents/providers.js'
import { offersQuickReplies, quickRepliesCall, type QuickRepliesCapture } from '../agents/quick-replies-stream.js'
import { codexThreadToResume, forgetCodexThread, rememberCodexThread } from '../agents/codex-threads.js'
import { repairBoxDefault, resolveRunModel } from '../agents/availability.js'
import { claudeTokenOf, claudeTokenOutlived } from '../connections/claude-token.js'
import { ensureCliAuth } from '../connections/cli-auth.js'
import { syncCodexAuth } from '../connections/codex-auth.js'
import { forgetCredentialRejected, recordCredentialRejected } from '../connections/credential-rejections.js'
import { recordRefusedModel } from '../connections/cli-models.js'
import { refreshCodexPlanLimits } from '../connections/codex-plan-limits.js'
import { armPlanLimitLatch, clearPlanLimitLatch } from '../connections/plan-limits.js'
import { refreshOpencodePlanLimits } from '../connections/opencode-plan-limits.js'
import { behaviourOf } from '../agents/opencode.js'
import { buildSystemPrompt, nowBlock, recallMemories, recallSection, systemPromptText, userBlock, userLanguageBlock } from '../agents/systemPrompt.js'
import type { LoadedAgent } from '../agents/types.js'
import { turnOrder } from '../agents/turn-order.js'
import { answeringModel } from '../agents/rerun-upstream.js'
import { listAgentIndex, setAgentStatus } from '../db/repos/agents.js'
import { appendMessage, lastMessageId, listSessionAuthorIds, setMessageToolCalls } from '../db/repos/messages.js'
import type { MessageRow } from '../db/schema.js'
import { isSharedConversation, signText } from './message-authors.js'
import { bumpRunStep, cancelRun, failRun, finishRun, getRun, setRunContext, startRun } from '../db/repos/runs.js'
import { advanceExecution, type ExecutionSnapshot } from '../db/repos/execution.js'
import { publishExecutionStart } from './execution-events.js'
import { insertRunStep, insertToolCall } from '../db/repos/telemetry.js'
import { touchSession } from '../db/repos/sessions.js'
import { logger } from '../lib/logger.js'
import { HttpError } from '../lib/errors.js'
import { newId, nowIso } from '../lib/ids.js'
import { buildTools } from '../tools/registry.js'
import { callTargetsOf } from '../tools/builtin/call-agent.js'
import { toolPayloadChars } from '../tools/payload.js'
import { prepareMcpServer } from '../tools/mcp.js'
import { withPooledRelays } from '../tools/mcp-relay.js'
import { HostBreaker } from '../tools/host-breaker.js'
import type { PartialResult, RunContext, RunTrigger, SkillProposalNotice } from './context.js'
import { partialResultsNote } from './partial-results.js'
import { claimSession, releaseSession, registerRunAbort, setRunCancel, unregisterRunAbort } from './run-control.js'
import { runCurator } from './curator.js'
import { repairToolCall } from './tool-repair.js'
import { stepWithScreenshots } from './screenshots.js'
import { authorMetadata, sendNotification, type NotificationKind } from './notify.js'
import { emitRunTerminal } from './run-events.js'
import { ClaudeSignInRenewedError, classifyFinishReason, classifyProviderError, errorMessageOf, isFailedFinish, ProviderRefusedError, ProviderStreamCutError, RUN_ERROR_CODES, refusalReason, unreachableEndpointError, type RunErrorCode } from './provider-errors.js'
import { armBudgetLatch, clearBudgetLatch, RERUN_BUDGET_ERROR_CODE } from './budget-latch.js'

export type RunOutcome = { kind: 'done' | 'error' | 'cancelled'; error?: string; errorCode?: RunErrorCode | null }

export type AgentRun = {
    result: StreamTextResult<ToolSet, never>
    runId: string
    // Resolves once owned work and cleanup finish. A hung preparation or close keeps ownership;
    // `result.finishReason` alone cannot say that the conversation is ready for its next run.
    settled: Promise<RunOutcome>
    contextUsage?: () => ContextOccupancy | undefined
    quickReplies?: () => QuickRepliesCapture | undefined
}

export type { RunTrigger }

// Warn about a stalled teardown without releasing ownership while it can still affect the run.
const CLOSE_WARN_MS = 15_000

function canonicalizeHitlNames(messages: ModelMessage[]): ModelMessage[] {
    return messages.map(m => {
        if (!Array.isArray(m.content)) return m
        let changed = false
        const content = m.content.map(part => {
            const p = part as { type?: string; toolName?: string }
            if ((p.type === 'tool-call' || p.type === 'tool-result') && isHitlToolName(p.toolName) && p.toolName !== canonicalHitlName(p.toolName)) {
                changed = true
                return { ...part, toolName: canonicalHitlName(p.toolName) }
            }
            return part
        })
        return changed ? ({ ...m, content } as ModelMessage) : m
    })
}

function coerceJsonArray(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

function questionSummary(input: Record<string, unknown> | undefined): string {
    const questions = coerceJsonArray(input?.questions) as Array<{ question?: unknown }> | undefined
    if (Array.isArray(questions) && questions.length > 0) {
        const first = String(questions[0]?.question ?? 'The coworker has a question')
        return questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first
    }
    return String(input?.question ?? 'The coworker has a question')
}

function serviceSummary(input: Record<string, unknown> | undefined): string {
    const services = coerceJsonArray(input?.services) as Array<{ slug?: unknown }> | undefined
    if (Array.isArray(services) && services.length > 0) {
        const first = String(services[0]?.slug ?? 'an app')
        return services.length > 1 ? `Set up ${first} (+${services.length - 1} more)` : `Set up ${first}`
    }
    return 'Set up an app'
}

function hitlKind(toolName: string): NotificationKind {
    if (toolName === 'ask_user') return 'question'
    // A secret request is a connector to finish setting up, from the user's point of view.
    if (toolName === 'suggest_service' || toolName === 'request_secret' || toolName === 'request_mcp_sign_in') return 'connector'
    return 'approval'
}

function hitlMessage(toolName: string, input: Record<string, unknown> | undefined): string {
    if (toolName === 'ask_user') return questionSummary(input)
    if (toolName === 'suggest_service') return serviceSummary(input)
    if (toolName === 'request_secret') return secretSummary(input)
    if (toolName === 'request_mcp_sign_in') return `Sign in to ${String(input?.name ?? 'an MCP server')}`
    if (toolName === 'request_takeover') return takeoverSummary(input)
    return approvalSummary(input)
}

async function emitHitlEvent(agent: LoadedAgent, sessionId: string, runId: string, pending: PendingHitl, author: MessageAuthor | undefined, execution: ExecutionSnapshot | null): Promise<void> {
    const kind = hitlKind(pending.toolName)
    const input = pending.input as Record<string, unknown> | undefined
    const message = hitlMessage(pending.toolName, input)
    await sendNotification({ event: 'agent.notification', kind, agentId: agent.id, sessionId, runId, message, execution, metadata: { toolCallId: pending.toolCallId, toolName: pending.toolName, input: pending.input, ...authorMetadata(author) } }).catch(() => {})
}

// The proposal never pauses the run, so it is announced after the terminal event: sent first, the
// run's `done` would put the conversation back to idle right behind it.
async function emitSkillProposalEvent(agent: LoadedAgent, sessionId: string, runId: string, notice: SkillProposalNotice, author: MessageAuthor | undefined): Promise<void> {
    const message = notice.mode === 'edit' ? `Wants to update a skill: ${notice.title}` : `Wants to save a new skill: ${notice.title}`
    await sendNotification({ event: 'agent.notification', kind: 'approval', agentId: agent.id, sessionId, runId, message, metadata: { toolName: 'skill_propose', proposalId: notice.proposalId, ...authorMetadata(author) } }).catch(() => {})
}

// OpenRouter's own cost, or what OpenCode says a step was worth to the user: 0 on the Go plan.
function costMicrosFrom(providerMetadata: unknown): number | null {
    const metadata = providerMetadata as { openrouter?: { usage?: { cost?: unknown } }; opencode?: { cost?: unknown } } | undefined
    const cost = metadata?.opencode?.cost ?? metadata?.openrouter?.usage?.cost
    return typeof cost === 'number' && Number.isFinite(cost) ? Math.round(cost * 1_000_000) : null
}

function safeJson(value: unknown): string | null {
    if (value === undefined) return null
    try {
        return JSON.stringify(value)
    } catch {
        return null
    }
}

type StepLike = {
    finishReason?: string
    text?: string
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number; inputTokenDetails?: { cacheWriteTokens?: number } }
    providerMetadata?: unknown
    toolCalls?: Array<{ toolCallId?: string; toolName: string; input?: unknown }>
    toolResults?: Array<{ toolCallId?: string; output?: unknown }>
}

async function recordStepTelemetry(agentId: string, sessionId: string, runId: string, provider: string, model: string, stepNumber: number, durationMs: number, step: StepLike, costMicros: number | null): Promise<void> {
    const calls = step.toolCalls ?? []
    const results = step.toolResults ?? []
    await insertRunStep(agentId, {
        id: newId(),
        runId,
        agentId,
        sessionId,
        stepNumber,
        provider,
        model,
        finishReason: step.finishReason ?? null,
        inputTokens: step.usage?.inputTokens ?? null,
        outputTokens: step.usage?.outputTokens ?? null,
        cachedInputTokens: step.usage?.cachedInputTokens ?? null,
        reasoningTokens: step.usage?.reasoningTokens ?? null,
        totalTokens: step.usage?.totalTokens ?? null,
        cacheWriteTokens: step.usage?.inputTokenDetails?.cacheWriteTokens ?? null,
        costMicros,
        toolCallCount: calls.length,
        textLength: step.text?.length ?? 0,
        durationMs,
        createdAt: nowIso(),
    })
    for (const call of calls) {
        const result = results.find(r => r.toolCallId === call.toolCallId)
        await insertToolCall(agentId, {
            id: newId(),
            runId,
            agentId,
            sessionId,
            stepNumber,
            toolCallId: call.toolCallId ?? null,
            toolName: call.toolName,
            inputJson: safeJson(call.input),
            resultJson: result ? safeJson(result.output) : null,
            isError: result ? 0 : 1,
            durationMs: null,
            createdAt: nowIso(),
        })
    }
}

export async function runAgent(agent: LoadedAgent, sessionId: string, userText: string, override?: ModelOverride, writer?: UIMessageStreamWriter, runId?: string, trigger: RunTrigger = { source: 'chat' }): Promise<AgentRun> {
    return runTurn(agent, sessionId, userText, override, writer, runId, trigger)
}

// How a turn ends. Everything terminal about a run is expressed as one of these three and handed to
// `settle`, which is the single place that writes the row, frees the session and tells the hub.
type Settlement =
    | { kind: 'done'; text: string; usage: LanguageModelUsage | undefined; costMicros: number | null; messages: ModelMessage[] }
    | { kind: 'error'; error: unknown; errorCode?: RunErrorCode | null; messages?: ModelMessage[] }
    | { kind: 'cancelled' }

type TerminalDecision = { owner: 'loop' | 'other'; outcome: RunOutcome }

class RunAlreadyEndedError extends Error {
    constructor() {
        super('run is no longer running')
    }
}

async function runTurn(baseAgent: LoadedAgent, sessionId: string, userText: string, override: ModelOverride | undefined, writer: UIMessageStreamWriter | undefined, runId: string | undefined, trigger: RunTrigger): Promise<AgentRun> {
    // The run row and its abort controller exist before any preparation step can throw: for chat
    // and headless callers the row was already inserted, and a throw in `resolveRunModel` or the
    // tool/MCP setup would otherwise leave it `running` forever with no terminal event for the hub.
    const claimedRunId = runId ?? newId()
    const holder = claimSession(sessionId, claimedRunId)
    if (holder && holder !== claimedRunId) throw new HttpError(409, 'a run is already in flight on this session', 'run_in_flight')
    const run = await (async () => {
        if (!runId) {
            const started = await startRun(baseAgent.id, sessionId, claimedRunId)
            publishExecutionStart(started)
            return started
        }
        const stored = await getRun(baseAgent.id, runId)
        if (!stored || stored.status !== 'running') throw new RunAlreadyEndedError()
        return { id: runId }
    })().catch(async error => {
        try {
            if (runId && !(error instanceof RunAlreadyEndedError)) {
                const message = errorMessageOf(error)
                const failed = await failRun(baseAgent.id, runId, message).catch(writeError => {
                    logger.error({ err: String(writeError), agent: baseAgent.id, run: runId }, 'startup failure could not be saved')
                    return undefined
                })
                if (failed !== false) {
                    const execution = await advanceExecution(baseAgent.id, sessionId, runId, { kind: 'terminal', state: 'error' }).catch(() => null)
                    await emitRunTerminal({ agentId: baseAgent.id, sessionId, runId, trigger, kind: 'error', error: message, provider: override?.provider ?? baseAgent.resolved.provider, model: override?.model ?? baseAgent.resolved.model, execution })
                }
            }
        } finally {
            releaseSession(claimedRunId)
        }
        throw error
    })
    const controller = registerRunAbort(run.id, baseAgent.id)
    const author = trigger.source === 'chat' ? trigger.author : undefined

    let agent = baseAgent
    let { connection, provider, model } = baseAgent.resolved
    let closeTools = async (): Promise<void> => {}
    let closeModel = async (): Promise<void> => {}
    let appendP: Promise<unknown> = Promise.resolve()
    let contextUsage: (() => ContextOccupancy | undefined) | undefined
    let quickReplies: (() => QuickRepliesCapture | undefined) | undefined
    let cliAuthP: Promise<() => void> | undefined
    let spawnToken: string | undefined
    let codexThreadId: string | undefined
    let steps = 0
    let finishPreparation!: () => void
    const preparationDone = new Promise<void>(resolve => { finishPreparation = resolve })
    const preparationTasks: Promise<unknown>[] = []
    const stepTasks = new Set<Promise<void>>()
    let completedMessages: ModelMessage[] = []
    const trackPreparation = <T>(task: Promise<T>): Promise<T> => {
        preparationTasks.push(task)
        void task.catch(() => {})
        return task
    }
    const partialResults: PartialResult[] = []
    const skillProposals: SkillProposalNotice[] = []

    // The CLI process owns the bridged MCP server that calls back into `tools`, so it goes down
    // first. Codex's own token refresh only lands in auth.json once it has exited, hence the sync
    // last. Every teardown path below funnels through this.
    const close = async (): Promise<void> => {
        try {
            await closeModel()
        } catch (err) {
            logger.warn({ err: String(err), agent: agent.id }, 'close model failed')
        }
        try {
            await closeTools()
        } catch (err) {
            logger.warn({ err: String(err), agent: agent.id }, 'close tools failed')
        }
        if (provider === 'codex') {
            await syncCodexAuth(connection).catch(() => {})
            void refreshCodexPlanLimits(connection)
        }
        if (provider === 'opencode') void refreshOpencodePlanLimits(connection)
    }

    const closeSafely = async (): Promise<void> => {
        const timer = setTimeout(() => {
            logger.warn({ agent: agent.id, run: run.id, provider }, 'run teardown still pending; conversation remains busy')
        }, CLOSE_WARN_MS)
        try {
            await close()
        } finally {
            clearTimeout(timer)
        }
    }

    let settled = false
    let resolveSettled!: (outcome: RunOutcome) => void
    const settledPromise = new Promise<RunOutcome>(resolve => {
        resolveSettled = resolve
    })

    // The one and only terminal path of a run. `streamText` gives no guarantee that `onFinish` or
    // `onError` is ever called -- a CLI provider that wedges on an expired token simply stops
    // streaming -- so every way a turn can end funnels here, and the guard makes a second arrival
    // a no-op instead of a duplicate row write and a duplicate hub event.
    const settle = async (settlement: Settlement): Promise<RunOutcome> => {
        if (settled) return settledPromise
        settled = true

        // Preparation can still acquire tools or a credential lease after Stop. Keep ownership
        // until those acquisitions finish, so cleanup sees them and no late write follows release.
        await preparationDone
        await Promise.allSettled(preparationTasks)
        await Promise.allSettled(stepTasks)

        let outcome: RunOutcome = { kind: 'error', error: 'run settlement failed' }
        let pending: PendingHitl | null = null
        let text: string | undefined = settlement.kind === 'done' ? settlement.text : undefined
        let usage: LanguageModelUsage | undefined
        let costMicros: number | null = null
        let terminalDecision: TerminalDecision | undefined
        let execution: ExecutionSnapshot | null = null
        const decideTerminal = async (written: boolean, proposed: RunOutcome): Promise<TerminalDecision> => {
            if (written) return { owner: 'loop', outcome: proposed }
            const stored = await getRun(agent.id, run.id)
            let existing: RunOutcome
            if (stored?.status === 'done') existing = { kind: 'done' }
            else if (stored?.status === 'cancelled') existing = { kind: 'cancelled' }
            else if (stored?.status === 'error') existing = { kind: 'error', error: stored.error ?? 'run failed', errorCode: null }
            else throw new Error('terminal transition did not leave a terminal row')
            return { owner: 'other', outcome: existing }
        }

        try {
            await appendP
            if (settlement.kind === 'done') {
                const messages = canonicalizeHitlNames(settlement.messages)
                let answerRow: MessageRow | undefined
                for (const message of messages) {
                    const row = await appendMessage(agent.id, sessionId, message)
                    if (row?.role === 'assistant') answerRow = row
                }
                pending = findPendingHitl(messages)
                // A turn that ends on a card ignores the replies: the card already says how to answer.
                const replies = quickReplies?.()
                if (replies && answerRow && !pending) await setMessageToolCalls(agent.id, answerRow.id, [quickRepliesCall(replies)]).catch(() => {})
                if (provider === 'rerun') clearBudgetLatch()
                if (provider === 'codex') await keepCodexThread().catch(() => forgetCodexThread(agent.id, sessionId))
                const pendingKind = pending ? hitlKind(pending.toolName) : undefined
                terminalDecision = await decideTerminal(await finishRun(agent.id, run.id, settlement.usage, steps, settlement.costMicros, contextUsage?.(), pendingKind === 'question' || pendingKind === 'approval' || pendingKind === 'connector' ? pendingKind : undefined), { kind: 'done' })
                outcome = terminalDecision.outcome
                await touchSession(agent.id, sessionId).catch(() => {})
                text = settlement.text
                usage = settlement.usage
                costMicros = settlement.costMicros
                if (connection) {
                    forgetCredentialRejected(connection.id)
                    clearPlanLimitLatch(connection.id)
                }
            } else if (settlement.kind === 'cancelled') {
                forgetCodexThread(agent.id, sessionId)
                for (const message of canonicalizeHitlNames(completedMessages)) await appendMessage(agent.id, sessionId, message)
                if (partialResults.length || completedMessages.length) await appendMessage(agent.id, sessionId, { role: 'assistant', content: partialResults.length ? partialResultsNote(partialResults) : 'Run stopped by the user.' })
                terminalDecision = await decideTerminal(await cancelRun(agent.id, run.id), { kind: 'cancelled' })
                outcome = terminalDecision.outcome
            } else {
                const renewed = settlement.errorCode === RUN_ERROR_CODES.unauthorized && provider === 'claude' && claudeTokenOutlived(connection, spawnToken)
                if (renewed) settlement = { ...settlement, error: new ClaudeSignInRenewedError(), errorCode: RUN_ERROR_CODES.authRenewed }
                if (settlement.errorCode === RUN_ERROR_CODES.refused) settlement = { ...settlement, error: new ProviderRefusedError(refusalReason(settlement.error)) }
                const unreachable = provider === 'custom' ? unreachableEndpointError(connection?.config.baseUrl, settlement.error) : null
                if (unreachable) settlement = { ...settlement, error: unreachable }
                const errorCode = settlement.errorCode ?? null
                const errorMessage = errorMessageOf(settlement.error)
                forgetCodexThread(agent.id, sessionId)
                logger.error({ err: errorMessage, errorCode, agent: agent.id, run: run.id }, 'run error')
                if (errorCode === RERUN_BUDGET_ERROR_CODE) armBudgetLatch()
                if (errorCode === RUN_ERROR_CODES.usageLimit && connection && connection.id !== RERUN_CONNECTION_ID) armPlanLimitLatch(connection.id)
                // The token is still on file, so the connection would keep reading "Ready" while every
                // run on it fails. The keyless Rerun connection answers for the hub's key, not the user's.
                if (errorCode === RUN_ERROR_CODES.unauthorized && connection && connection.id !== RERUN_CONNECTION_ID) recordCredentialRejected(connection.id)
                // Codex's answer to a real request outranks the list it gave: the model is greyed out from now
                // on, and a box default naming it moves to one the account serves.
                if (errorCode === RUN_ERROR_CODES.modelNotInPlan && provider === 'codex' && connection) {
                    const refusedOn = connection
                    recordRefusedModel(refusedOn.id, model)
                    await repairBoxDefault(refusedOn).catch(err => logger.warn({ err: String(err), connection: refusedOn.id }, 'box default repair failed'))
                }
                // A turn that failed mid-flight still said things worth keeping; without this the user
                // loses everything the agent had already produced.
                for (const message of canonicalizeHitlNames(settlement.messages ?? completedMessages)) await appendMessage(agent.id, sessionId, message)
                terminalDecision = await decideTerminal(await failRun(agent.id, run.id, errorMessage), { kind: 'error', error: errorMessage, errorCode })
                outcome = terminalDecision.outcome
            }
        } catch (error) {
            const message = errorMessageOf(error)
            if (terminalDecision) {
                outcome = terminalDecision.outcome
                logger.warn({ err: message, agent: agent.id, run: run.id }, 'post-terminal bookkeeping failed')
            } else {
                pending = null
                outcome = { kind: 'error', error: message, errorCode: null }
                logger.error({ err: message, agent: agent.id, run: run.id }, 'run settlement failed')
                try {
                    terminalDecision = await decideTerminal(await failRun(agent.id, run.id, message), outcome)
                    outcome = terminalDecision.outcome
                } catch (writeError) {
                    const writeMessage = errorMessageOf(writeError)
                    outcome = { kind: 'error', error: `${message}; failed to save terminal state: ${writeMessage}`, errorCode: null }
                    logger.error({ err: writeMessage, agent: agent.id, run: run.id }, 'terminal failure could not be saved')
                }
            }
        } finally {
            try {
                await closeSafely()
            } catch (error) {
                logger.warn({ err: String(error), agent: agent.id, run: run.id }, 'run cleanup failed')
            } finally {
                try {
                    await cliAuthP?.then(release => release(), () => {}).catch(err => logger.warn({ err: String(err), agent: agent.id }, 'release cli auth failed'))
                    try {
                        await setAgentStatus(agent.id, 'idle')
                    } catch (error) {
                        logger.warn({ err: String(error), agent: agent.id }, 'setAgentStatus idle failed')
                    }
                } finally {
                    try {
                        if (terminalDecision?.owner !== 'other') {
                            const attention = pending ? hitlKind(pending.toolName) : undefined
                            execution = await advanceExecution(agent.id, sessionId, run.id, { kind: 'terminal', state: outcome.kind === 'error' ? 'error' : 'idle', ...(attention === 'question' || attention === 'approval' || attention === 'connector' ? { attention } : {}) })
                        }
                    } catch (error) {
                        logger.error({ err: String(error), agent: agent.id, run: run.id }, 'execution terminal state could not be saved')
                    } finally {
                        unregisterRunAbort(run.id)
                        resolveSettled(outcome)
                    }
                }
            }
        }

        if (terminalDecision?.owner === 'other') return outcome

        if (pending) {
            // A run waiting on a human stays "awaiting" only because no terminal event is sent.
            await emitHitlEvent(agent, sessionId, run.id, pending, author, execution)
        } else {
            await emitRunTerminal({
                agentId: agent.id,
                sessionId,
                runId: run.id,
                trigger,
                kind: outcome.kind === 'error' ? 'error' : 'done',
                cancelled: outcome.kind === 'cancelled',
                text,
                error: outcome.error,
                errorCode: outcome.errorCode,
                usage,
                stepCount: steps,
                provider,
                model,
                costMicros,
                execution,
            })
            const proposed = skillProposals.at(-1)
            if (outcome.kind === 'done' && proposed) await emitSkillProposalEvent(agent, sessionId, run.id, proposed, author)
        }

        if (outcome.kind === 'done' && !pending && agent.config.selfImprovement.enabled && userText) {
            void runCurator(agent, sessionId, userText, text ?? '', override).catch(e => logger.warn({ err: String(e) }, 'curator failed'))
        }

        return outcome
    }

    // The thread is only worth resuming once it holds the same turns as the session: the marker is
    // the last message written, so anything appended after this turn sends the next one to a new thread.
    const keepCodexThread = async (): Promise<void> => {
        const throughMessageId = codexThreadId ? await lastMessageId(agent.id, sessionId) : undefined
        if (!codexThreadId || !throughMessageId) return forgetCodexThread(agent.id, sessionId)
        rememberCodexThread(agent.id, sessionId, { threadId: codexThreadId, connectionId: connection?.id ?? RERUN_CONNECTION_ID, throughMessageId })
    }

    // Stop has to be able to end a run the provider refuses to end: codex ignores the abort signal
    // until its turn has started, which is exactly the state an expired token leaves it in.
    setRunCancel(run.id, () => {
        void settle({ kind: 'cancelled' }).catch(err => logger.warn({ err: String(err), agent: agent.id, run: run.id }, 'run cancel failed'))
    })

    try {
        controller.signal.throwIfAborted()
        // The recall waits on the hub's embedding: it runs alongside the whole preparation rather
        // than after it. It never rejects, a failed search only means no memories this turn.
        const memoriesP = trackPreparation(recallMemories(baseAgent, userText))
        // An override can name a different box connection than the agent's default, so the run works
        // off a view of the agent bound to the connection it will actually bill. The connection object
        // itself stays the shared instance, so a token refreshed here is refreshed for everyone.
        const resolved = await resolveRunModel(baseAgent, override)
        controller.signal.throwIfAborted()
        agent = resolved === baseAgent.resolved ? baseAgent : { ...baseAgent, resolved }
        ;({ connection, provider, model } = resolved)
        const t0 = Date.now()
        const order = turnOrder(provider, await answeringModel(provider, model))
        controller.signal.throwIfAborted()
        const callableAgentIds = trigger.source === 'chat' ? trigger.callableAgentIds : undefined
        const ctx: RunContext = { agent, sessionId, logger, provider, model, turnOrder: order, author, writer, abortSignal: controller.signal, callTargets: [], callableAgentIds, hostBreaker: new HostBreaker(), partialResults, skillProposals }

        ctx.runId = run.id
        const triggerSlug = 'slug' in trigger ? trigger.slug : null
        trackPreparation(setRunContext(agent.id, run.id, { provider, model, triggerSource: trigger.source, triggerSlug }).catch(() => {}))

        const callTargetsP = agent.config.tools.callAgent ? listAgentIndex().then(idx => callTargetsOf(idx, agent.id, callableAgentIds)) : Promise.resolve([])
        const toolsP = trackPreparation(callTargetsP.then(callTargets => {
            controller.signal.throwIfAborted()
            ctx.callTargets = callTargets
            return buildTools(ctx)
        }).then(built => {
            closeTools = built.close
            return built
        }))
        const preparedP = trackPreparation(CLI_PROVIDERS.has(provider) ? Promise.all(agent.config.mcpServers.map(s => trackPreparation(prepareMcpServer(agent.id, s, agent.env)))) : Promise.resolve([]))
        // Claude reaches its servers through the engine's connections; Codex starts its own without
        // holding up the model, so it keeps dialing them as declared.
        const mcpServersP = trackPreparation(provider === 'claude' ? preparedP.then(servers => {
            controller.signal.throwIfAborted()
            return withPooledRelays(agent, servers)
        }) : preparedP)
        cliAuthP = trackPreparation(ensureCliAuth(provider, connection))

        trackPreparation(setAgentStatus(agent.id, 'busy').catch(err => logger.warn({ err: String(err), agent: agent.id }, 'setAgentStatus busy failed')))

        const system = await buildSystemPrompt(agent, trigger, provider, order)
        controller.signal.throwIfAborted()
        const systemText = systemPromptText(system)

        const pastAuthorIds = await listSessionAuthorIds(agent.id, sessionId).catch(() => [])
        controller.signal.throwIfAborted()
        const shared = isSharedConversation(author ? [...pastAuthorIds, author.id] : pastAuthorIds)

        // The tools come first: their schemas ride along on every step, so the compaction threshold
        // has to count them with the history.
        const built = await toolsP
        controller.signal.throwIfAborted()
        const { tools } = built
        const history = repairToolPairs(await prepareRunHistory(ctx, systemText, override, shared, toolPayloadChars(tools)))
        controller.signal.throwIfAborted()

        const [memories, mcpServers] = await Promise.all([memoriesP, mcpServersP, cliAuthP])
        controller.signal.throwIfAborted()
        const recall = recallSection(memories, history)

        // Read before the turn is stored: a resumed thread only gets this turn, so the session must
        // hold nothing the thread has not seen.
        const resumeThreadId = provider === 'codex' ? codexThreadToResume(agent.id, sessionId, connection?.id ?? RERUN_CONNECTION_ID, await lastMessageId(agent.id, sessionId)) : undefined
        controller.signal.throwIfAborted()

        // The turn is stored as it is sent, its context part included: the history the next turn
        // replays is then byte for byte the prompt the provider already cached. Only the signature
        // stays out of the row, `signHistoryMessage` puts it back on a shared conversation.
        // A shared conversation already signs each turn with its sender.
        const suffix = [recall, shared ? '' : userBlock(author?.name), userLanguageBlock(trigger.source === 'chat' ? trigger.userLanguage : undefined), nowBlock()].filter(Boolean).join('\n\n')
        const context = suffix ? [contextTextPart(suffix)] : []
        appendP = appendMessage(agent.id, sessionId, { role: 'user', content: [{ type: 'text', text: userText }, ...context] }, author)
        appendP.catch(err => logger.error({ err: String(err), agent: agent.id }, 'append user message failed'))

        const turnText = shared ? signText(userText, author) : userText
        const turnMessages: ModelMessage[] = [...history, { role: 'user', content: [{ type: 'text', text: turnText }, ...context] }]

        const cached = applyCaching(provider, { system, messages: turnMessages, sessionId, model })
        logger.debug({ agent: agent.id, provider, prepMs: Date.now() - t0 }, 'run prep done')

        spawnToken = claudeTokenOf(connection)
        const resolvedModel = resolveModel(agent, override, tools, mcpServers, { system: systemText, screenshots: id => ctx.screenshots?.get(id), sessionId })
        closeModel = resolvedModel.close
        contextUsage = resolvedModel.contextUsage
        // Cut out of the text whoever wrote it; only a coworker that offers replies gets the buttons.
        if (offersQuickReplies(agent.config)) quickReplies = resolvedModel.quickReplies
        const languageModel = resolvedModel.model
        controller.signal.throwIfAborted()

        let lastStepAt = Date.now()
        let runCostMicros: number | null = null
        const result = streamText({
            model: languageModel,
            system: cached.system,
            messages: cached.messages,
            providerOptions: mergeProviderOptions(mergeProviderOptions(cached.providerOptions, reasoningProviderOptions(provider, model)), resumeThreadId ? { 'codex-app-server': { threadId: resumeThreadId } } : undefined),
            tools,
            abortSignal: controller.signal,
            experimental_repairToolCall: repairToolCall,
            stopWhen: ({ steps }) => hitlTurnIsOver(steps, CLI_PROVIDERS.has(provider)),
            // The step that writes the message a bare card is missing gets no tool: `toolChoice`
            // rather than an empty `activeTools`, since Anthropic refuses a transcript holding
            // tool_use blocks when the request defines no tool.
            prepareStep: ({ messages, steps }) => {
                const step = stepWithScreenshots(messages, ctx.screenshots, provider, model, connection)
                return {
                    ...step,
                    ...(behaviourOf(provider, model) === 'anthropic' ? { messages: withTailBreakpoint(step.messages ?? messages) } : {}),
                    ...(!CLI_PROVIDERS.has(provider) && hitlStepLacksMessage(steps) ? { toolChoice: 'none' as const } : {}),
                }
            },
            onStepFinish: async step => {
                if (settled || controller.signal.aborted) return
                // The SDK snapshot is cumulative; replacing it preserves completed tool results
                // without duplicating earlier steps if a later step is interrupted.
                completedMessages = step.response.messages
                const task = (async () => {
                    steps += 1
                    const now = Date.now()
                    const durationMs = now - lastStepAt
                    lastStepAt = now
                    const stepCostMicros = costMicrosFrom(step.providerMetadata)
                    if (stepCostMicros !== null) runCostMicros = (runCostMicros ?? 0) + stepCostMicros
                    await bumpRunStep(agent.id, run.id, steps).catch(() => {})
                    if (settled || controller.signal.aborted) return
                    await recordStepTelemetry(agent.id, sessionId, run.id, provider, model, steps, durationMs, step, stepCostMicros).catch(err => logger.warn({ err: String(err), agent: agent.id }, 'record step telemetry failed'))
                })()
                stepTasks.add(task)
                try {
                    await task
                } finally {
                    stepTasks.delete(task)
                }
            },
            onError: async ({ error }) => {
                if (controller.signal.aborted) {
                    await settle({ kind: 'cancelled' })
                    return
                }
                await settle({ kind: 'error', error, errorCode: classifyProviderError(provider, error) })
            },
            // The only callback the SDK runs when the abort lands before the first step: without it
            // a run stopped early would never write its terminal row.
            onAbort: async () => {
                await settle({ kind: 'cancelled' })
            },
            // `totalUsage`, not `usage`: the latter is the last step alone, and a run that called
            // tools paid every step before it.
            onFinish: async ({ response, totalUsage, text, providerMetadata, finishReason, rawFinishReason }) => {
                if (controller.signal.aborted) {
                    await settle({ kind: 'cancelled' })
                    return
                }
                logger.info({ agent: agent.id, provider, cachedInputTokens: totalUsage.cachedInputTokens, costMicros: runCostMicros, anthropic: providerMetadata?.anthropic }, 'run usage')
                const threadId = providerMetadata?.['codex-app-server']?.threadId
                if (typeof threadId === 'string') codexThreadId = threadId
                // A CLI provider reports a spent subscription or a blown context as a plain finish,
                // not as an error. Taken at face value it stores an empty turn as a success and the
                // reason the agent said nothing is lost.
                if (isFailedFinish(finishReason, rawFinishReason)) {
                    const errorCode = classifyFinishReason(finishReason, rawFinishReason)
                    await settle({
                        kind: 'error',
                        error: errorCode === RUN_ERROR_CODES.streamIncomplete ? new ProviderStreamCutError() : new Error(rawFinishReason ?? finishReason),
                        errorCode,
                        messages: response.messages,
                    })
                    return
                }
                await settle({ kind: 'done', text, usage: totalUsage, costMicros: runCostMicros ?? costMicrosFrom(providerMetadata), messages: response.messages })
            },
        })
        finishPreparation()

        // Drains the stream so the run advances with no HTTP consumer attached, and closes the run
        // when the provider ends the turn without ever reaching a callback. `teeStream` hands out a
        // fresh branch on every access, so this takes nothing away from `toUIMessageStream`.
        void (async () => {
            let drainError: unknown
            await result.consumeStream({
                onError: error => {
                    drainError = error
                },
            })
            await settle(
                controller.signal.aborted
                    ? { kind: 'cancelled' }
                    : {
                          kind: 'error',
                          error: drainError ?? new ProviderStreamCutError(),
                          errorCode: drainError ? classifyProviderError(provider, drainError) : RUN_ERROR_CODES.streamIncomplete,
                      },
            )
        })().catch(err => logger.warn({ err: String(err), agent: agent.id, run: run.id }, 'run drain failed'))

        return { result, runId: run.id, settled: settledPromise, contextUsage, quickReplies }
    } catch (err) {
        finishPreparation()
        // Everything past `streamText` is handled by its own callbacks: the `return` above makes
        // this catch unreachable once the stream has started, so a run is closed exactly once.
        if (controller.signal.aborted) {
            await settle({ kind: 'cancelled' })
            throw err
        }
        await settle({ kind: 'error', error: err, errorCode: classifyProviderError(provider, err) })
        throw err
    }
}
