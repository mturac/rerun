import type { ExternalAgentProvider } from './types.js'
import { claudeCliProvider, codexCliProvider } from './cli.js'
import { codexProvider } from './codex.js'
import { cursorProvider } from './cursor.js'

export type { ExternalAgentLaunch, ExternalAgentProvider, ExternalAgentStatus, ExternalAgentTask } from './types.js'

// Credentials resolve agent env first, then the process environment: an agent that was given a
// CURSOR_API_KEY through request_secret or its .env reaches the provider without the box needing
// a global key, and a self-hosted engine can still set one for every agent.
export function externalAgentProviders(agentId: string, agentEnv: Record<string, string>, env: NodeJS.ProcessEnv = process.env): ExternalAgentProvider[] {
    const cursorKey = agentEnv.CURSOR_API_KEY || env.CURSOR_API_KEY || ''
    return [cursorProvider(cursorKey), codexProvider({ agentEnv, env }), codexCliProvider(agentId, agentEnv, env), claudeCliProvider(agentId, agentEnv, env)]
}

export function configuredProviders(agentId: string, agentEnv: Record<string, string>, env: NodeJS.ProcessEnv = process.env): ExternalAgentProvider[] {
    return externalAgentProviders(agentId, agentEnv, env).filter(provider => provider.isConfigured())
}
