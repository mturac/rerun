import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { configuredProviders, type ExternalAgentProvider } from '../../external-agents/index.js'
import type { RunContext } from '../../runtime/context.js'

export function externalAgentTools(ctx: RunContext): ToolSet {
    const providers = configuredProviders(ctx.agent.id, ctx.agent.env)
    const byName = new Map<string, ExternalAgentProvider>(providers.map(provider => [provider.name, provider]))
    const roster = providers.map(provider => provider.name).join(', ')

    const pick = (name: string | undefined): ExternalAgentProvider | { error: string } => {
        if (byName.size === 0) return { error: 'No external agent provider is configured on this coworker. Set CURSOR_API_KEY for Cursor Cloud Agents, or connect a Codex/ChatGPT account (or CODEX_OAUTH_TOKEN + CODEX_OAUTH_ACCOUNT_ID) for Codex Cloud tasks, in its environment.' }
        const provider = name ? byName.get(name) : providers[0]
        if (!provider) return { error: `Unknown external agent provider "${name}". Configured providers: ${roster}.` }
        return provider
    }

    return {
        external_agent_start: tool({
            description:
                'Hand a self-contained coding task to an external cloud coding agent (e.g. Cursor Cloud Agents) that works on its own VM against a git repository and can open a pull request. Use it for work that belongs in a repo you cannot reach from this workspace. The task runs asynchronously: this returns the agent id and status, not the result. Poll external_agent_status for progress and the PR link.' +
                (roster ? ` Configured providers: ${roster}.` : ''),
            inputSchema: z.object({
                provider: z.string().optional().describe('External agent provider. Defaults to the only configured one.'),
                prompt: z.string().describe('The full task description for the external agent'),
                repository: z.string().optional().describe('Git repository URL the agent should work on'),
                ref: z.string().optional().describe('Branch or ref to start from'),
                branchName: z.string().optional().describe('Branch name for the agent to push its work to'),
                model: z.string().optional().describe('Provider-specific model override'),
                autoCreatePr: z.boolean().optional().describe('Whether the provider should open a pull request when done'),
            }),
            execute: async ({ provider, prompt, repository, ref, branchName, model, autoCreatePr }) => {
                const picked = pick(provider)
                if ('error' in picked) return picked
                const task = await picked.launch({ prompt, repository, ref, branchName, model, autoCreatePr })
                return { ok: true, provider: picked.name, task }
            },
        }),

        external_agent_status: tool({
            description: 'Check the status of an external cloud agent task: queued/running/completed/failed, its summary, branch and pull request URL when finished.',
            inputSchema: z.object({
                provider: z.string().optional().describe('External agent provider. Defaults to the only configured one.'),
                id: z.string().describe('The external agent id returned by external_agent_start'),
            }),
            execute: async ({ provider, id }) => {
                const picked = pick(provider)
                if ('error' in picked) return picked
                const task = await picked.status(id)
                return { ok: true, provider: picked.name, task }
            },
        }),

        external_agent_followup: tool({
            description: 'Send a follow-up message to a running or finished external cloud agent, for example to request changes on its pull request.',
            inputSchema: z.object({
                provider: z.string().optional().describe('External agent provider. Defaults to the only configured one.'),
                id: z.string().describe('The external agent id'),
                prompt: z.string().describe('The follow-up instruction'),
            }),
            execute: async ({ provider, id, prompt }) => {
                const picked = pick(provider)
                if ('error' in picked) return picked
                if (!picked.followup) return { error: `Provider "${picked.name}" does not support follow-ups.` }
                const task = await picked.followup(id, prompt)
                return { ok: true, provider: picked.name, task }
            },
        }),

        external_agent_stop: tool({
            description: 'Stop a running external cloud agent task.',
            inputSchema: z.object({
                provider: z.string().optional().describe('External agent provider. Defaults to the only configured one.'),
                id: z.string().describe('The external agent id'),
            }),
            execute: async ({ provider, id }) => {
                const picked = pick(provider)
                if ('error' in picked) return picked
                if (!picked.stop) return { error: `Provider "${picked.name}" does not support stopping tasks.` }
                await picked.stop(id)
                return { ok: true, provider: picked.name, id }
            },
        }),

        external_agent_list: tool({
            description: 'List recent external cloud agent tasks on the configured provider.',
            inputSchema: z.object({
                provider: z.string().optional().describe('External agent provider. Defaults to the only configured one.'),
            }),
            execute: async ({ provider }) => {
                const picked = pick(provider)
                if ('error' in picked) return picked
                if (!picked.list) return { error: `Provider "${picked.name}" does not support listing tasks.` }
                const tasks = await picked.list()
                return { ok: true, provider: picked.name, tasks }
            },
        }),
    }
}
