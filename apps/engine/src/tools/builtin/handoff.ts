import { tool, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { contextTextPart } from '@rerun/contracts'
import { getAgent } from '../../agents/registry.js'
import { appendMessage, listMessages } from '../../db/repos/messages.js'
import type { MessageRow } from '../../db/schema.js'
import { createSession } from '../../db/repos/sessions.js'
import { startHeadlessRun } from '../../runtime/headless-run.js'
import { sendNotification } from '../../runtime/notify.js'
import type { RunContext } from '../../runtime/context.js'
import { resolveTargetAgent } from './call-agent.js'

// Written into the handoff marker's hidden context part so a later handoff in the same
// conversation can rebuild which coworkers already held it, across sessions.
export const HANDOFF_HELD_TAG = 'rerun-handoff-held:'

const HELD_RE = /rerun-handoff-held:\s*([^\n]+)/

export function heldIdsFromRows(rows: Pick<MessageRow, 'contentJson'>[]): Set<string> {
    const held = new Set<string>()
    for (const row of rows) {
        let content: unknown
        try {
            content = JSON.parse(row.contentJson)
        } catch {
            continue
        }
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : [])) : []
        for (const text of texts) {
            const match = text.match(HELD_RE)
            if (!match) continue
            for (const id of match[1].split(',')) {
                const trimmed = id.trim()
                if (trimmed) held.add(trimmed)
            }
        }
    }
    return held
}

export function handoffMarkerParts(fromName: string, toName: string, held: ReadonlySet<string>, note?: string) {
    const context = [
        `${HANDOFF_HELD_TAG} ${[...held].join(', ')}`,
        note ? `Note from ${fromName}: ${note}` : null,
    ]
        .filter(Boolean)
        .join('\n')
    return [{ type: 'text' as const, text: `Handoff: ${fromName} passed this conversation to ${toName}.` }, contextTextPart(context)]
}

export function handoffTools(ctx: RunContext): ToolSet {
    const targets = ctx.callTargets ?? []
    const roster = targets.map(t => `${t.name} (id: ${t.id})`).join(', ')
    return {
        handoff: tool({
            description:
                'Hand this whole conversation to another coworker of the workspace: its transcript is copied into a new session owned by the target, which then continues it under its own personality, tools and memory, while you stop. Use it when the request belongs to a specific coworker by role or expertise, not for a self-contained subtask (use delegate_tasks) or a one-shot message (use call_agent). A coworker that already held this conversation cannot take it back unless you set allowReturn.' +
                (roster ? ` Coworkers you can hand off to: ${roster}.` : ''),
            inputSchema: z.object({
                agent: z.string().describe('Name or id of the coworker to hand the conversation to'),
                note: z.string().optional().describe('What the coworker should know or pick up first'),
                allowReturn: z.boolean().default(false).describe('Allow handing back to a coworker that already held this conversation. Default false'),
            }),
            execute: async ({ agent: ref, note, allowReturn }) => {
                const resolved = resolveTargetAgent(ref, targets)
                if ('error' in resolved) return `(handoff failed: ${resolved.error})`

                const target = await getAgent(resolved.agent.id)
                if (!target.config.enabled) return `(handoff failed: coworker "${target.config.name}" is switched off and cannot take the conversation.)`

                const rows = await listMessages(ctx.agent.id, ctx.sessionId)
                const held = heldIdsFromRows(rows)
                held.add(ctx.agent.id)
                if (held.has(target.id) && !allowReturn) {
                    return `(handoff rejected: ${target.config.name} already held this conversation. Answer it yourself, or pass allowReturn to hand it back anyway.)`
                }
                held.add(target.id)

                const config = structuredClone(target.config)
                config.selfImprovement.enabled = false
                const callee = { ...target, config }

                const session = await createSession(
                    callee.id,
                    `from ${ctx.agent.config.name}: ${(note ?? 'handoff').slice(0, 80)}`,
                    { originAgentId: ctx.agent.id, originSessionId: ctx.sessionId },
                    'agent',
                )

                // The transcript moves with the conversation: every stored row is replayed into the
                // target's session with its original timestamps, then the marker and the prompt
                // that starts the target's first run.
                for (const row of rows) {
                    const author = row.authorId ? { id: row.authorId, ...(row.authorName ? { name: row.authorName } : {}) } : undefined
                    await appendMessage(callee.id, session.id, { role: row.role, content: JSON.parse(row.contentJson) } as ModelMessage, author, row.createdAt)
                }
                await appendMessage(callee.id, session.id, { role: 'user', content: handoffMarkerParts(ctx.agent.config.name, callee.config.name, held, note) })

                await sendNotification({
                    event: 'agent.session.created',
                    kind: 'info',
                    agentId: callee.id,
                    sessionId: session.id,
                    runId: null,
                    message: `Handed off by ${ctx.agent.config.name}`,
                    title: session.title,
                    source: 'agent',
                    originAgentId: ctx.agent.id,
                })

                const prompt = note
                    ? `${ctx.agent.config.name} handed this conversation to you. Continue it from where it left off. Note from ${ctx.agent.config.name}: ${note}`
                    : `${ctx.agent.config.name} handed this conversation to you. Continue it from where it left off.`

                try {
                    await startHeadlessRun(callee, session.id, prompt, undefined, { source: 'chat', callableAgentIds: ctx.callableAgentIds })
                } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err)
                    return `(handoff failed: could not start ${callee.config.name}: ${reason})`
                }

                ctx.handoffCompleted = true
                return `Handed off to ${callee.config.name}. The conversation continues in ${callee.config.name}'s session "${session.title}".`
            },
        }),
    }
}
