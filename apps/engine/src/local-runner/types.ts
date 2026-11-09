import { z } from 'zod'

export const APPROVAL_TEXT_LIMIT = 320
export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000

export const runnerModeSchema = z.enum(['never', 'ask', 'always'])
export type RunnerMode = z.infer<typeof runnerModeSchema>

export const runnerTaskKindSchema = z.enum(['shell', 'file.read', 'file.write'])
export type RunnerTaskKind = z.infer<typeof runnerTaskKindSchema>

export const runnerTaskSchema = z
    .object({
        kind: runnerTaskKindSchema,
        subject: z.string().max(200).optional(),
        taskKey: z.string().max(300).optional(),
        approvalText: z.string().max(4000).optional(),
        command: z.string().max(8000).optional(),
        cwd: z.string().max(1000).optional(),
        path: z.string().max(1000).optional(),
        content: z.string().max(1_000_000).optional(),
    })
    .superRefine((task, ctx) => {
        if (task.kind === 'shell' && !task.command) {
            ctx.addIssue({ code: 'custom', message: 'shell tasks need a command', path: ['command'] })
        }
        if (task.kind !== 'shell' && !task.path) {
            ctx.addIssue({ code: 'custom', message: `${task.kind} tasks need a path`, path: ['path'] })
        }
        if (task.kind === 'file.write' && task.content === undefined) {
            ctx.addIssue({ code: 'custom', message: 'file.write tasks need content', path: ['content'] })
        }
    })

export type RunnerTask = z.infer<typeof runnerTaskSchema>

// A task parked in ask mode until a caller approves or denies it. Persisted by the runner so a
// daemon restart does not strand the approval; expiresAtMs keeps the pending TTL honest.
export type PendingApproval = {
    id: string
    task: RunnerTask
    taskKey: string
    action: string
    text: string
    expiresAtMs: number
}

export const approvalDecisionSchema = z.object({
    decision: z.enum(['approve', 'deny']),
    scope: z.enum(['once', 'always']).optional(),
})
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
