import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { dataDir } from '../../config/paths.js'
import { pickRunnerTarget, runnerTargets, type RunnerTarget } from '../../local-runner/credentials.js'
import { runnerTaskSchema } from '../../local-runner/types.js'
import type { RunContext } from '../../runtime/context.js'

const TASK_TIMEOUT_MS = 130_000
const OUTPUT_LIMIT = 50_000

type RunnerResponse = {
    status?: string
    pendingId?: string
    approvalText?: string
    reason?: string
    exitCode?: number | null
    stdout?: string
    stderr?: string
    error?: string
    path?: string
    bytes?: number
    approvals?: PendingApproval[]
}

type PendingApproval = {
    id: string
    approvalText?: string
    taskKey?: string
    action?: string
    kind?: string
    subject?: string | null
    expiresAt?: string
}

type RunnerAnswer = { status: number; body: RunnerResponse } | { error: string }

function describeTargets(targets: RunnerTarget[]): string {
    return targets.map(target => `${target.name} (${target.id})`).join(', ') || 'none'
}

async function runnerRequest(target: RunnerTarget, path: string, init: RequestInit, signal: AbortSignal): Promise<RunnerAnswer> {
    try {
        const res = await fetch(`${target.url}${path}`, {
            ...init,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
            signal,
        })
        const body = (await res.json().catch(() => ({}))) as RunnerResponse
        return { status: res.status, body }
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
    }
}

function taskOutput(body: RunnerResponse): string {
    if (body.status === 'pending') {
        return `Runner needs approval before running this task (pending ${body.pendingId}). It asked: ${body.approvalText ?? '(no text)'} Use runner_approvals to see it and runner_approve to resolve it — but only after the user has told you to approve or deny on their behalf; otherwise relay the approval text to the user and let them decide.`
    }
    if (body.status === 'denied') return `Runner denied the task${body.reason ? `: ${body.reason}` : ''}.`
    const head = [`status: ${body.status ?? 'unknown'}`]
    if (body.exitCode !== undefined && body.exitCode !== null) head.push(`exitCode: ${body.exitCode}`)
    if (body.error) head.push(`error: ${body.error}`)
    if (body.path) head.push(`path: ${body.path}`)
    if (body.bytes !== undefined) head.push(`bytes: ${body.bytes}`)
    const out = [body.stdout, body.stderr ? `[stderr]\n${body.stderr}` : ''].filter(Boolean).join('\n')
    return `${head.join('\n')}${out ? `\n${out.slice(0, OUTPUT_LIMIT)}` : ''}`
}

function pendingLines(approvals: (PendingApproval & { runnerName: string })[]): string {
    if (approvals.length === 0) return 'No local runner has tasks waiting for approval.'
    return approvals
        .map(approval => {
            const bits = [`${approval.id} on ${approval.runnerName}`]
            if (approval.action) bits.push(approval.action)
            if (approval.expiresAt) bits.push(`expires ${approval.expiresAt}`)
            return `- ${bits.join(' · ')}\n  ${approval.approvalText ?? '(no approval text)'}`
        })
        .join('\n')
}

export function localRunnerTools(ctx: RunContext): ToolSet {
    const runnerOption = z.string().max(120).optional().describe('Runner id or name when several are paired; defaults to the most recently seen.')

    const noRunner = (runner: string | undefined, targets: RunnerTarget[]) => {
        if (runner) return `No local runner matches "${runner}". Paired runners: ${describeTargets(targets)}.`
        return 'No local runner is registered on this engine. Pair one with `rerun local-runner pair` and start it with `rerun local-runner start`.'
    }

    const resolveTarget = (runner: string | undefined): { target?: RunnerTarget; targets: RunnerTarget[] } => {
        const targets = runnerTargets(dataDir())
        if (runner) {
            const target = pickRunnerTarget(targets, runner)
            return target ? { target, targets } : { targets }
        }
        return { targets }
    }

    return {
        runner_task: tool({
            description:
                "Run a task on a local runner: a daemon on the user's own machine, reached over HTTP with the token it announced at start. kind 'shell' runs a command (optional cwd), 'file.read' reads a file and 'file.write' writes one; paths stay inside the runner's root directory. The runner applies its own Never/Ask/Always permission mode, so a task that needs approval comes back saying so instead of running. Use it for work that must happen on the user's machine rather than inside this engine's workspace.",
            inputSchema: z.object({
                runner: runnerOption,
                task: runnerTaskSchema.describe('The task to run on the runner.'),
            }),
            execute: async ({ runner, task }) => {
                const targets = runnerTargets(dataDir())
                const target = pickRunnerTarget(targets, runner)
                if (!target) return noRunner(runner, targets)
                const timeout = AbortSignal.timeout(TASK_TIMEOUT_MS)
                const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout
                const answer = await runnerRequest(target, '/tasks', { method: 'POST', body: JSON.stringify(task) }, signal)
                if ('error' in answer) {
                    if (ctx.abortSignal?.aborted) throw new Error(answer.error)
                    return `runner_task failed: ${answer.error}`
                }
                if (answer.status < 200 || answer.status >= 300) {
                    return `runner_task failed (${answer.status}): ${answer.body.error ?? 'the runner rejected the task'}`
                }
                return taskOutput(answer.body)
            },
        }),

        runner_approvals: tool({
            description:
                'List tasks parked for approval on paired local runners (Ask permission mode holds a task until someone decides). Each entry gives the approval id, its runner, what it asked, and when it expires. Use after runner_task reports a task is pending, or when the user asks what is waiting on their runners.',
            inputSchema: z.object({ runner: runnerOption }),
            execute: async ({ runner }) => {
                const targets = runnerTargets(dataDir())
                if (runner && !pickRunnerTarget(targets, runner)) return noRunner(runner, targets)
                const scoped = runner ? targets.filter(target => pickRunnerTarget([target], runner)) : targets
                if (scoped.length === 0) return noRunner(runner, targets)
                const timeout = AbortSignal.timeout(TASK_TIMEOUT_MS)
                const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout
                type ListAnswer = { target: RunnerTarget; error: string } | { target: RunnerTarget; approvals: (PendingApproval & { runnerName: string })[] }
                const answers = await Promise.all(
                    scoped.map(async (target): Promise<ListAnswer> => {
                        const answer = await runnerRequest(target, '/approvals', {}, signal)
                        if ('error' in answer) return { target, error: answer.error }
                        if (answer.status !== 200) return { target, error: `HTTP ${answer.status}` }
                        return {
                            target,
                            approvals: (answer.body.approvals ?? []).map(approval => ({ ...approval, runnerName: target.name })),
                        }
                    }),
                )
                const approvals = answers.flatMap(answer => ('approvals' in answer ? answer.approvals : []))
                const failures = answers.flatMap(answer => ('error' in answer ? [`${answer.target.name}: ${answer.error}`] : []))
                const head = pendingLines(approvals)
                return failures.length ? `${head}\nCould not reach: ${failures.join('; ')}` : head
            },
        }),

        runner_approve: tool({
            description:
                "Approve or deny one pending local-runner task: approve runs it, deny refuses it and the runner remembers. ONLY call this when the user explicitly told you to approve or deny on their behalf — never on your own initiative; otherwise show them the approvalText and let them decide. approvalId and runner come from runner_approvals; runner may be omitted with a single runner. scope 'always' persists the grant; default 'once'.",
            inputSchema: z.object({
                runner: runnerOption,
                approvalId: z.string().min(1).max(100).describe('Pending approval id, from runner_approvals or a runner_task pending result.'),
                decision: z.enum(['approve', 'deny']).describe('approve runs the parked task; deny refuses it.'),
                scope: z.enum(['once', 'always']).optional().describe("'always' persists the grant on the runner; defaults to 'once'. Ignored for deny."),
            }),
            execute: async ({ runner, approvalId, decision, scope }) => {
                const { target, targets } = resolveTarget(runner)
                if (runner && !target) return noRunner(runner, targets)
                const candidates = target ? [target] : targets
                if (candidates.length === 0) return noRunner(runner, targets)
                const timeout = AbortSignal.timeout(TASK_TIMEOUT_MS)
                const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout
                const errors: string[] = []
                for (const candidate of candidates) {
                    const answer = await runnerRequest(
                        candidate,
                        `/approvals/${encodeURIComponent(approvalId)}`,
                        { method: 'POST', body: JSON.stringify({ decision, ...(scope ? { scope } : {}) }) },
                        signal,
                    )
                    if ('error' in answer) {
                        errors.push(`${candidate.name}: ${answer.error}`)
                        continue
                    }
                    if (answer.status === 404 && candidates.length > 1 && !target) continue
                    if (answer.status === 404 || answer.status === 410) {
                        return `runner_approve failed (${answer.status}): ${answer.body.error ?? 'unknown or expired approval'}`
                    }
                    if (answer.status < 200 || answer.status >= 300) {
                        return `runner_approve failed (${answer.status}): ${answer.body.error ?? 'the runner rejected the decision'}`
                    }
                    return `${decision === 'approve' ? 'Approved' : 'Denied'} on ${candidate.name}.\n${taskOutput(answer.body)}`
                }
                if (errors.length === candidates.length) return `runner_approve failed: no runner answered (${errors.join('; ')})`
                return 'runner_approve failed (404): unknown or expired approval'
            },
        }),
    }
}
