import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { create } from 'tar'
import matter from 'gray-matter'
import { z } from 'zod'
import { agentConfigSchema, mcpServerSchema, type AgentImportResult } from '@rerun/contracts'
import { newId, nowIso, slugify } from '../lib/ids.js'
import { importAgent } from './import.js'

// A Grok Bot agent package is the canonical import format for a bot exported or reconstructed
// from Grok Bot's template setup context (automations, plugins, memories, skills) plus the agent
// fields its share/instantiate schema carries. Field names accept both the camelCase a hand-built
// package uses and the snake_case the wire format uses.
export const grokBotSkillSchema = z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    content: z.string().default(''),
}).loose()
export type GrokBotSkill = z.infer<typeof grokBotSkillSchema>

const grokBotMemorySchema = z.object({
    content: z.string().min(1),
    kind: z.string().optional(),
    tier: z.string().optional(),
    scope: z.string().optional(),
    tags: z.array(z.string()).default([]),
    createdAt: z.string().optional(),
    created_at: z.string().optional(),
})
export type GrokBotMemory = z.infer<typeof grokBotMemorySchema>

export const grokBotAutomationSchema = z.object({
    name: z.string().min(1),
    prompt: z.string().optional(),
    body: z.string().optional(),
    instruction: z.string().optional(),
    description: z.string().optional(),
    cron: z.string().optional(),
    schedule: z.string().optional(),
    runAt: z.string().optional(),
    run_at: z.string().optional(),
    timezone: z.string().optional(),
    enabled: z.boolean().optional(),
    webhook: z.union([z.boolean(), z.object({ methods: z.array(z.string()).optional() }).loose()]).optional(),
    trigger: z.object({ methods: z.array(z.string()).optional() }).loose().optional(),
})
export type GrokBotAutomation = z.infer<typeof grokBotAutomationSchema>

export const grokBotPluginSchema = z.object({
    name: z.string().optional(),
    slug: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    description: z.string().optional(),
    mcpServer: mcpServerSchema.optional(),
}).refine(plugin => plugin.name !== undefined || plugin.slug !== undefined || plugin.id !== undefined, { message: 'a plugin needs a name, slug, or id' })
export type GrokBotPlugin = z.infer<typeof grokBotPluginSchema>

export const grokBotPackageSchema = z.object({
    name: z.string().min(1),
    displayName: z.string().optional(),
    title: z.string().optional(),
    description: z.string().default(''),
    purpose: z.string().optional(),
    instructions: z.string().optional(),
    persona: z.string().optional(),
    language: z.string().optional(),
    avatar: z.unknown().optional(),
    templateId: z.string().optional(),
    template_id: z.string().optional(),
    shareId: z.string().optional(),
    share_id: z.string().optional(),
    origin: z.string().optional(),
    teamBotTeamId: z.union([z.string(), z.number()]).optional(),
    team_bot_team_id: z.union([z.string(), z.number()]).optional(),
    skills: z.array(grokBotSkillSchema).default([]),
    memories: z.array(grokBotMemorySchema).default([]),
    automations: z.array(grokBotAutomationSchema).default([]),
    plugins: z.array(grokBotPluginSchema).default([]),
    mcpServers: z.array(mcpServerSchema).default([]),
    mcp_servers: z.array(mcpServerSchema).default([]),
})
export type GrokBotPackage = z.infer<typeof grokBotPackageSchema>

export type GrokBotImportResult = AgentImportResult & { warnings: string[] }

function uniqueSlug(base: string, used: Set<string>): string {
    const root = slugify(base) || 'item'
    let slug = root
    for (let i = 2; used.has(slug); i++) slug = `${root}-${i}`
    used.add(slug)
    return slug
}

function pluginLabel(plugin: GrokBotPlugin): string {
    return plugin.name ?? plugin.slug ?? String(plugin.id)
}

function automationBody(automation: GrokBotAutomation): string {
    return (automation.prompt ?? automation.body ?? automation.instruction ?? '').trim()
}

function automationCron(automation: GrokBotAutomation): string | null {
    return automation.cron ?? automation.schedule ?? null
}

function automationRunAt(automation: GrokBotAutomation): string | null {
    return automation.runAt ?? automation.run_at ?? null
}

type TriggerPayload = Record<string, unknown>

type AutomationTriggerPlan =
    | { kind: 'none' }
    | { kind: 'webhook' }
    | { kind: 'cron'; cron: string | null }
    | { kind: 'unsupported'; reason: string }

const WEBHOOK_TRIGGER_TYPES = new Set(['webhook', 'http', 'https'])
const SCHEDULE_TRIGGER_TYPES = new Set(['cron', 'schedule'])
const WEBHOOK_PAYLOAD_KEYS = ['url', 'uri', 'endpoint', 'path', 'hook', 'methods', 'method']
const TRIGGER_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function payloadType(payload: TriggerPayload): string | null {
    const type = payload.type
    return typeof type === 'string' && type.trim() ? type.trim() : null
}

function looksLikeWebhook(payload: TriggerPayload): boolean {
    return WEBHOOK_PAYLOAD_KEYS.some(key => payload[key] !== undefined)
}

function classifyTriggerPayload(payload: TriggerPayload): 'webhook' | 'cron' | 'listener' | 'unknown' {
    const type = payloadType(payload)?.toLowerCase() ?? null
    if (type !== null && WEBHOOK_TRIGGER_TYPES.has(type)) return 'webhook'
    if (type !== null && SCHEDULE_TRIGGER_TYPES.has(type)) return 'cron'
    if (type !== null) return 'listener'
    return looksLikeWebhook(payload) ? 'webhook' : 'unknown'
}

function cronExpressionFrom(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const inner = (value as TriggerPayload).expression ?? (value as TriggerPayload).cron
        if (typeof inner === 'string' && inner.trim()) return inner.trim()
    }
    return null
}

function triggerCronExpression(payload: TriggerPayload): string | null {
    for (const key of ['cron', 'expression', 'schedule']) {
        const cron = cronExpressionFrom(payload[key])
        if (cron) return cron
    }
    return null
}

function automationTriggerPlan(automation: GrokBotAutomation): AutomationTriggerPlan {
    if (automation.webhook === true) return { kind: 'webhook' }
    const payload = (typeof automation.webhook === 'object' && automation.webhook !== null ? automation.webhook : automation.trigger) as TriggerPayload | undefined
    if (payload === undefined) return { kind: 'none' }

    const classified = classifyTriggerPayload(payload)
    if (classified === 'webhook') return { kind: 'webhook' }
    if (classified === 'cron') return { kind: 'cron', cron: triggerCronExpression(payload) }

    const type = payloadType(payload)
    const reason = type ? `trigger type "${type}"` : 'a trigger shape Rerun cannot classify'
    return { kind: 'unsupported', reason }
}

function automationMethods(automation: GrokBotAutomation): string[] {
    const fromTrigger = automation.trigger?.methods
    const fromWebhook = typeof automation.webhook === 'object' && automation.webhook !== null ? automation.webhook.methods : undefined
    const methods = (fromTrigger ?? fromWebhook ?? []).map(method => method.toUpperCase()).filter(method => TRIGGER_METHODS.has(method))
    return methods.length > 0 ? methods : ['POST']
}

const SKILL_BODY_KEYS = new Set(['name', 'description', 'content'])
const SKILL_FRONTMATTER_WRAPPERS = new Set(['frontmatter', 'frontMatter', 'front_matter'])

function skillFrontmatter(skill: GrokBotSkill): Record<string, unknown> {
    const frontmatter: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(skill)) {
        if (SKILL_BODY_KEYS.has(key) || value === undefined) continue
        if (SKILL_FRONTMATTER_WRAPPERS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
            Object.assign(frontmatter, value)
            continue
        }
        frontmatter[key] = value
    }
    frontmatter.name = skill.name
    frontmatter.description = skill.description
    return frontmatter
}

function soulFor(pkg: GrokBotPackage): string {
    const name = pkg.displayName?.trim() || pkg.title?.trim() || pkg.name
    const mission = (pkg.description || pkg.purpose || '').trim()
    const persona = (pkg.persona || pkg.instructions || '').trim()
    const language = pkg.language?.trim()

    const sections = [
        `# ${name}`,
        '',
        `You are ${name}, an autonomous coworker who owns outcomes end to end — break goals down, act, verify your own work, and keep going until the goal is met or only the user can decide.`,
        '',
        mission ? `Your mission: ${mission}` : 'You do not yet have a fixed mission. Infer the user\'s intent from what they ask, and pursue it end to end.',
    ]
    if (persona) sections.push('', '## Persona', '', persona)
    sections.push('', 'Voice: lead with the result, stay concrete and specific, and match the user\'s language and tone.')
    if (language) sections.push(`Write and reply in ${language}.`)
    return `${sections.join('\n')}\n`
}

function installDocFor(pkg: GrokBotPackage, mcpCount: number): string | null {
    const lines: string[] = []
    if (pkg.plugins.length > 0) {
        lines.push('## Plugins to install', '')
        for (const plugin of pkg.plugins) {
            const label = pluginLabel(plugin)
            lines.push(`- Install the "${label}" plugin${plugin.description ? ` — ${plugin.description}` : ''} and connect any account it asks for.`)
        }
        lines.push('')
    }
    if (mcpCount > 0) {
        lines.push('## MCP servers to configure', '')
        lines.push('This agent carries MCP server definitions in its config. Sign in or supply credentials for each before relying on its tools.')
        lines.push('')
    }
    if (pkg.automations.length > 0) {
        lines.push('## Automations imported paused', '')
        lines.push(`${pkg.automations.length} automation(s) arrived switched off. Review each schedule or webhook trigger, then enable the ones that should run.`)
        lines.push('')
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : null
}

export function grokBotToFiles(pkg: GrokBotPackage): { files: Record<string, string>; warnings: string[] } {
    const warnings: string[] = []
    const files: Record<string, string> = {}
    const now = nowIso()

    const pluginMcpServers = pkg.plugins.map(plugin => plugin.mcpServer).filter(server => server !== undefined)
    const mcpServers = [...pkg.mcpServers, ...pkg.mcp_servers, ...pluginMcpServers]

    const displayName = pkg.displayName?.trim() || pkg.title?.trim() || ''
    const description = (pkg.description || pkg.purpose || '').trim()
    const needsInstall = pkg.plugins.length > 0

    const config = agentConfigSchema.parse({
        name: pkg.name,
        kind: 'user',
        displayName: displayName || undefined,
        description,
        mcpServers,
        setup: { required: needsInstall, completedAt: null, sessionId: null },
    })
    files['config.json'] = `${JSON.stringify(config, null, 2)}\n`
    files['SOUL.md'] = soulFor(pkg)

    const install = installDocFor(pkg, mcpServers.length)
    if (install) files['INSTALL.md'] = install

    const usedSkills = new Set<string>()
    for (const skill of pkg.skills) {
        const slug = uniqueSlug(skill.name, usedSkills)
        files[`skills/${slug}/SKILL.md`] = matter.stringify(`\n${skill.content.trim()}\n`, skillFrontmatter(skill))
    }

    const usedAutomations = new Set<string>()
    for (const automation of pkg.automations) {
        const slug = uniqueSlug(automation.name, usedAutomations)
        const body = automationBody(automation)
        const cron = automationCron(automation)
        const runAt = automationRunAt(automation)
        if (!body) {
            warnings.push(`automation "${automation.name}" has no prompt/body and was skipped`)
            continue
        }
        const plan = automationTriggerPlan(automation)
        if (plan.kind === 'webhook') {
            files[`triggers/${slug}.md`] = matter.stringify(`\n${body}\n`, {
                name: automation.name,
                description: automation.description ?? '',
                enabled: false,
                token: '',
                methods: automationMethods(automation),
                createdAt: now,
            })
            if (cron || runAt) warnings.push(`automation "${automation.name}" has both a webhook trigger and a schedule; it was imported as a trigger only`)
        } else {
            let scheduleCron = cron
            let scheduleRunAt = runAt
            let scheduleTimezone = automation.timezone
            if (plan.kind === 'cron') {
                scheduleCron = plan.cron ?? cron
                if (!scheduleCron && !scheduleRunAt) warnings.push(`automation "${automation.name}" declares a cron trigger but carries no cron expression; imported as a disabled schedule without timing`)
            } else if (plan.kind === 'unsupported') {
                warnings.push(`automation "${automation.name}" uses ${plan.reason}, which Rerun cannot express; imported as a disabled schedule with no trigger`)
                scheduleCron = null
                scheduleRunAt = null
                scheduleTimezone = undefined
            }
            files[`schedules/${slug}.md`] = matter.stringify(`\n${body}\n`, {
                name: automation.name,
                description: automation.description ?? '',
                enabled: false,
                ...(scheduleCron ? { cron: scheduleCron } : {}),
                ...(scheduleRunAt ? { runAt: scheduleRunAt } : {}),
                ...(scheduleTimezone ? { timezone: scheduleTimezone } : {}),
                createdAt: now,
            })
        }
    }

    for (const memory of pkg.memories) {
        const id = newId()
        const createdAt = memory.createdAt ?? memory.created_at ?? now
        files[`memory/${id}.md`] = matter.stringify(`\n${memory.content.trim()}\n`, {
            id,
            kind: memory.kind ?? 'journal',
            tags: memory.tags,
            createdAt,
        })
    }

    const manifest = {
        version: 1,
        source: 'grokbot',
        sourceAgentId: pkg.shareId ?? pkg.share_id ?? pkg.templateId ?? pkg.template_id ?? '',
        capturedAt: now,
        envKeys: [],
        mcpAuth: [],
        redactions: [],
        excludedPaths: [],
    }
    files['.rerun-capture.json'] = `${JSON.stringify(manifest, null, 2)}\n`

    if (pkg.avatar !== undefined) warnings.push('avatar was dropped: Rerun agents have no avatar field')
    const tieredMemories = pkg.memories.filter(memory => memory.tier !== undefined || memory.scope !== undefined)
    if (tieredMemories.length > 0) warnings.push(`${tieredMemories.length} memory entr${tieredMemories.length === 1 ? 'y' : 'ies'} carried tier/scope metadata that Rerun does not model; imported as flat memories`)
    if (pkg.plugins.length > 0) warnings.push(`${pkg.plugins.length} plugin(s) listed in INSTALL.md; install them from the service catalog after import`)

    return { files, warnings }
}

export async function grokBotToArchive(pkg: GrokBotPackage): Promise<{ stream: Readable; bytes: number; warnings: string[] }> {
    const { files, warnings } = grokBotToFiles(pkg)
    const staging = await mkdtemp(resolve(tmpdir(), 'rerun-grokbot-'))
    const tarball = resolve(staging, 'archive.tar.gz')

    try {
        for (const [path, content] of Object.entries(files)) {
            const target = resolve(staging, path)
            await mkdir(resolve(target, '..'), { recursive: true })
            await writeFile(target, content, 'utf8')
        }
        await create({ gzip: true, cwd: staging, portable: true, file: tarball }, ['.'])
        const { size } = await stat(tarball)
        const stream = createReadStream(tarball)
        const cleanup = () => {
            void rm(staging, { recursive: true, force: true })
        }
        stream.on('close', cleanup)
        stream.on('error', cleanup)
        return { stream, bytes: size, warnings }
    } catch (err) {
        await rm(staging, { recursive: true, force: true })
        throw err
    }
}

export async function importGrokBotPackage(pkg: GrokBotPackage, options: { name?: string; displayName?: string } = {}): Promise<GrokBotImportResult> {
    const { stream, warnings } = await grokBotToArchive(pkg)
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
    const result = await importAgent({
        body,
        name: options.name ?? pkg.name,
        displayName: options.displayName ?? pkg.displayName ?? pkg.title ?? '',
        keepAutomationsDisabled: true,
    })
    return { ...result, warnings }
}
