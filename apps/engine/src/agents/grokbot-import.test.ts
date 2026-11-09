import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-gb-'))

const { beforeAll, describe, expect, it } = await import('vitest')
const { grokBotPackageSchema, grokBotToFiles, importGrokBotPackage } = await import('./grokbot-import.js')
const { agentConfigSchema } = await import('./types.js')
const { agentDir } = await import('../config/paths.js')
const { readFile } = await import('node:fs/promises')
const { migrate } = await import('../db/migrate.js')
const { listAgentIndex } = await import('../db/repos/agents.js')

const pkg = grokBotPackageSchema.parse({
    name: 'support-bot',
    displayName: 'Support Bot',
    description: 'Answers support tickets and escalates billing questions.',
    purpose: 'customer_support',
    language: 'English',
    template_id: 'tpl-123',
    skills: [
        { name: 'Refund Policy', description: 'How refunds work', content: 'Read the refund policy before answering.' },
        { name: 'Refund Policy', description: 'Duplicate name', content: 'Second skill with the same name.' },
    ],
    memories: [
        { content: 'The support queue is busiest on Mondays.', created_at: '2026-01-05T00:00:00.000Z' },
        { content: 'Escalate anything about legal threats.', kind: 'note' },
    ],
    automations: [
        { name: 'Morning triage', prompt: 'Summarize overnight tickets.', cron: '0 9 * * *', timezone: 'Europe/Paris' },
        { name: 'Stripe webhook', body: 'A refund event arrived, log it.', webhook: true },
        { name: 'Empty one', prompt: '   ' },
    ],
    plugins: [{ name: 'stripe', description: 'Payments' }],
    mcpServers: [{ name: 'docs', url: 'https://mcp.example.com/docs', args: [], env: {}, headers: {} }],
})

beforeAll(async () => {
    await migrate()
})

describe('grokBotToFiles', () => {
    it('writes a valid config.json the importer schema accepts', () => {
        const { files } = grokBotToFiles(pkg)
        const config = agentConfigSchema.parse(JSON.parse(files['config.json']))
        expect(config.name).toBe('support-bot')
        expect(config.displayName).toBe('Support Bot')
        expect(config.description).toContain('support tickets')
        expect(config.setup.required).toBe(true)
        expect(config.mcpServers.map(s => s.name)).toEqual(['docs'])
    })

    it('composes a SOUL.md with mission, persona and language', () => {
        const { files } = grokBotToFiles(pkg)
        expect(files['SOUL.md']).toContain('# Support Bot')
        expect(files['SOUL.md']).toContain('support tickets')
        expect(files['SOUL.md']).toContain('English')
    })

    it('writes skills with deduplicated slugs and frontmatter', () => {
        const { files } = grokBotToFiles(pkg)
        const paths = Object.keys(files).filter(p => p.startsWith('skills/'))
        expect(paths).toHaveLength(2)
        expect(paths[0]).not.toBe(paths[1])
        expect(files[paths[0]]).toContain('name: Refund Policy')
    })

    it('writes memories as journal-kind files keeping created_at', () => {
        const { files } = grokBotToFiles(pkg)
        const memories = Object.entries(files).filter(([p]) => p.startsWith('memory/'))
        expect(memories).toHaveLength(2)
        const first = memories.find(([, c]) => c.includes('busiest on Mondays'))
        expect(first?.[1]).toContain('kind: journal')
        expect(first?.[1]).toContain('2026-01-05T00:00:00.000Z')
    })

    it('imports cron automations paused and webhook ones as disabled triggers', () => {
        const { files, warnings } = grokBotToFiles(pkg)
        const schedule = Object.entries(files).find(([p]) => p.startsWith('schedules/'))
        expect(schedule?.[0]).toContain('morning-triage')
        expect(schedule?.[1]).toContain('enabled: false')
        expect(schedule?.[1]).toContain('cron: 0 9 * * *')
        const trigger = Object.entries(files).find(([p]) => p.startsWith('triggers/'))
        expect(trigger?.[1]).toContain('enabled: false')
        expect(trigger?.[1]).toContain('token')
        expect(warnings.some(w => w.includes('Empty one'))).toBe(true)
    })

    it('lists plugins in INSTALL.md and marks setup required', () => {
        const { files } = grokBotToFiles(pkg)
        expect(files['INSTALL.md']).toContain('stripe')
        expect(files['INSTALL.md']).toContain('paused')
    })

    it('warns about dropped avatars', () => {
        const { warnings } = grokBotToFiles(grokBotPackageSchema.parse({ ...pkg, avatar: { shape: 'bot' } }))
        expect(warnings.some(w => w.includes('avatar'))).toBe(true)
    })

    it('classifies trigger objects by type instead of treating every trigger as a webhook', () => {
        const typed = grokBotPackageSchema.parse({
            name: 'typed-triggers',
            automations: [
                { name: 'Slack ping', prompt: 'React to the slack message.', trigger: { type: 'slack', channel: '#ops' } },
                { name: 'Issue triage', prompt: 'Triage the github issue.', trigger: { type: 'github' } },
                { name: 'Nightly cron', prompt: 'Run the nightly job.', trigger: { type: 'cron', cron: '*/30 * * * *' } },
                { name: 'Inbound hook', prompt: 'Handle the webhook call.', trigger: { type: 'webhook', methods: ['post'] } },
                { name: 'Bare methods', prompt: 'Handle the bare call.', trigger: { methods: ['GET', 'POST'] } },
                { name: 'Linear sync', prompt: 'Sync the linear issue.', trigger: { type: 'linear' } },
                { name: 'Mystery trigger', prompt: 'Unknown shape.', trigger: { events: ['x'] } },
            ],
        })
        const { files, warnings } = grokBotToFiles(typed)

        const triggerPaths = Object.keys(files).filter(path => path.startsWith('triggers/'))
        expect(triggerPaths.sort()).toEqual(['triggers/bare-methods.md', 'triggers/inbound-hook.md'])
        expect(files['triggers/inbound-hook.md']).toContain('POST')
        expect(files['triggers/bare-methods.md']).toContain('GET')
        expect(files['triggers/bare-methods.md']).toContain('POST')

        for (const slug of ['slack-ping', 'issue-triage', 'nightly-cron', 'linear-sync', 'mystery-trigger']) {
            const schedule = files[`schedules/${slug}.md`]
            expect(schedule, slug).toBeDefined()
            expect(schedule).toContain('enabled: false')
        }
        expect(files['schedules/nightly-cron.md']).toContain('*/30 * * * *')
        expect(files['schedules/slack-ping.md']).not.toContain('cron:')
        expect(files['schedules/linear-sync.md']).not.toContain('cron:')

        expect(warnings.some(w => w.includes('Slack ping') && w.includes('slack'))).toBe(true)
        expect(warnings.some(w => w.includes('Issue triage') && w.includes('github'))).toBe(true)
        expect(warnings.some(w => w.includes('Linear sync') && w.includes('linear'))).toBe(true)
        expect(warnings.some(w => w.includes('Mystery trigger') && w.includes('cannot classify'))).toBe(true)
        expect(warnings.some(w => w.includes('Nightly cron'))).toBe(false)
    })

    it('maps a cron trigger without an expression onto the automation schedule fields', () => {
        const { files, warnings } = grokBotToFiles(grokBotPackageSchema.parse({
            name: 'cron-fallback',
            automations: [
                { name: 'Has cron field', prompt: 'Nightly.', cron: '0 8 * * *', trigger: { type: 'cron' } },
                { name: 'No timing at all', prompt: 'Whenever.', trigger: { type: 'cron' } },
            ],
        }))
        expect(files['schedules/has-cron-field.md']).toContain('0 8 * * *')
        expect(files['schedules/no-timing-at-all.md']).toBeDefined()
        expect(files['schedules/no-timing-at-all.md']).not.toContain('cron:')
        expect(warnings.some(w => w.includes('No timing at all') && w.includes('no cron expression'))).toBe(true)
        expect(warnings.some(w => w.includes('Has cron field'))).toBe(false)
    })

    it('preserves extra skill frontmatter keys in the emitted SKILL.md', () => {
        const { files } = grokBotToFiles(grokBotPackageSchema.parse({
            name: 'skilled',
            skills: [{
                name: 'Deploy',
                description: 'How to deploy',
                content: 'Run the deploy pipeline.',
                globs: ['src/**'],
                alwaysApply: true,
                frontmatter: { environments: ['prod'], metadata: { owner: 'ops' } },
            }],
        }))
        const skill = files['skills/deploy/SKILL.md']
        expect(skill).toContain('name: Deploy')
        expect(skill).toContain('globs:')
        expect(skill).toContain('alwaysApply: true')
        expect(skill).toContain('environments:')
        expect(skill).toContain('owner: ops')
        expect(skill).not.toContain('frontmatter:')
    })

    it('warns when memories carry tier/scope metadata that gets flattened', () => {
        const { warnings, files } = grokBotToFiles(grokBotPackageSchema.parse({
            name: 'memories',
            memories: [
                { content: 'Profile fact.', tier: 'profile', scope: 'agent' },
                { content: 'Plain note.' },
            ],
        }))
        expect(warnings.some(w => w.includes('tier/scope'))).toBe(true)
        expect(Object.keys(files).filter(path => path.startsWith('memory/'))).toHaveLength(2)

        const clean = grokBotToFiles(grokBotPackageSchema.parse({ name: 'clean', memories: [{ content: 'Plain.' }] }))
        expect(clean.warnings.some(w => w.includes('tier/scope'))).toBe(false)
    })
})

describe('importGrokBotPackage', () => {
    it('imports end to end through the standard archive path', async () => {
        const result = await importGrokBotPackage(pkg)
        expect(result.name).toBe('support-bot')
        expect(result.warnings.length).toBeGreaterThan(0)

        const root = agentDir(result.id)
        expect(await readFile(resolve(root, 'SOUL.md'), 'utf8')).toContain('Support Bot')
        expect(await readFile(resolve(root, 'skills/refund-policy/SKILL.md'), 'utf8')).toContain('refund policy')
        const imported = agentConfigSchema.parse(JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8')))
        expect(imported.setup.completedAt).toBeNull()
        expect((await listAgentIndex()).some(row => row.id === result.id)).toBe(true)
    })
})
