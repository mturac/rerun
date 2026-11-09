export type ExternalAgentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'

export type ExternalAgentTask = {
    provider: string
    id: string
    name: string
    status: ExternalAgentStatus
    url?: string
    prUrl?: string
    summary?: string
    branch?: string
    error?: string
    // Parsed NDJSON/JSONL events from CLIs running with a structured output format, newest last.
    events?: unknown[]
    raw: unknown
}

export type ExternalAgentLaunch = {
    prompt: string
    repository?: string
    ref?: string
    branchName?: string
    model?: string
    autoCreatePr?: boolean
}

export interface ExternalAgentProvider {
    name: string
    isConfigured(): boolean
    launch(input: ExternalAgentLaunch): Promise<ExternalAgentTask>
    status(id: string): Promise<ExternalAgentTask>
    followup?(id: string, prompt: string): Promise<ExternalAgentTask>
    stop?(id: string): Promise<void>
    list?(): Promise<ExternalAgentTask[]>
}
