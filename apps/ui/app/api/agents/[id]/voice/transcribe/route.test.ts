import { AuthorizationError, UnauthenticatedError } from '@/app/api/_auth/errors'
import { resolveRunTarget } from '@/app/api/_services/chat.service'
import { EngineRequestError } from '@/lib/engine/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const transcribeAgentVoice = vi.fn()
vi.mock('@/app/api/_services/chat.service', () => ({ resolveRunTarget: vi.fn() }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ NoEngineError: class NoEngineError extends Error {} }))
vi.mock('@/lib/engine/client', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/engine/client')>()),
    transcribeAgentVoice: (...args: unknown[]) => transcribeAgentVoice(...args),
}))

const { POST } = await import('./route')

const params = Promise.resolve({ id: 'agent-1' })
const conn = { baseUrl: 'https://engine.test', apiKey: 'k' }

function post(url: string, body: BodyInit | null = new Uint8Array([1, 2, 3])) {
    return POST(new Request(url, { method: 'POST', body }), { params })
}

describe('POST /api/agents/[id]/voice/transcribe', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(resolveRunTarget).mockResolvedValue({ engineAgentId: 'engine-agent', conn, contentLocked: false })
        transcribeAgentVoice.mockResolvedValue('hello there')
    })

    it('forwards the recording and answers with the transcript', async () => {
        const res = await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=webm')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ text: 'hello there' })
        expect(transcribeAgentVoice).toHaveBeenCalledWith(conn, 'engine-agent', expect.any(ArrayBuffer), 'webm')
    })

    it('refuses a missing or malformed format before touching the engine', async () => {
        expect((await post('https://rerun.test/api/agents/agent-1/voice/transcribe')).status).toBe(400)
        expect((await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=../../etc')).status).toBe(400)
        expect(resolveRunTarget).not.toHaveBeenCalled()
    })

    it('refuses an empty or oversized body', async () => {
        expect((await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=webm', new Uint8Array(0))).status).toBe(400)
        expect((await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=webm', new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413)
        expect(transcribeAgentVoice).not.toHaveBeenCalled()
    })

    it('answers 404 for a coworker outside the workspace and 401 when signed out', async () => {
        vi.mocked(resolveRunTarget).mockRejectedValueOnce(new AuthorizationError('Coworker not found'))
        expect((await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=webm')).status).toBe(404)
        vi.mocked(resolveRunTarget).mockRejectedValueOnce(new UnauthenticatedError())
        expect((await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=webm')).status).toBe(401)
    })

    it('relays the engine status and message', async () => {
        transcribeAgentVoice.mockRejectedValueOnce(new EngineRequestError('stt unavailable: no whisper model', 503))
        const res = await post('https://rerun.test/api/agents/agent-1/voice/transcribe?format=webm')
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: 'stt unavailable: no whisper model' })
    })
})
