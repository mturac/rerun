import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const KEYS = ['RERUN_DATA_DIR', 'RERUN_PORT', 'RERUN_HOST', 'RERUN_API_KEY', 'RERUN_HUB_BASE_URL', 'RERUN_WEB_SEARCH_FALLBACK', 'RERUN_LOG_LEVEL', 'RERUN_CODEX_PATH']

async function freshEnv(values: Record<string, string | undefined> = {}) {
    vi.resetModules()
    for (const key of KEYS) vi.stubEnv(key, values[key])
    const { env } = await import('./env.js')
    return env
}

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('env', () => {
    it('fills the defaults on an empty environment', async () => {
        const env = await freshEnv()
        expect(env()).toEqual({ RERUN_DATA_DIR: resolve(homedir(), '.rerun'), RERUN_PORT: 3000, RERUN_HOST: '0.0.0.0', RERUN_LOG_LEVEL: 'info' })
    })

    it('reads every variable it knows', async () => {
        const env = await freshEnv({
            RERUN_DATA_DIR: '/data',
            RERUN_PORT: '8080',
            RERUN_HOST: '127.0.0.1',
            RERUN_API_KEY: 'key',
            RERUN_HUB_BASE_URL: 'https://hub.example.com',
            RERUN_LOG_LEVEL: 'debug',
            RERUN_CODEX_PATH: '/usr/local/bin/codex',
            RERUN_WEB_SEARCH_FALLBACK: 'mwmbl',
        })
        expect(env()).toEqual({
            RERUN_DATA_DIR: '/data',
            RERUN_PORT: 8080,
            RERUN_HOST: '127.0.0.1',
            RERUN_API_KEY: 'key',
            RERUN_HUB_BASE_URL: 'https://hub.example.com',
            RERUN_LOG_LEVEL: 'debug',
            RERUN_CODEX_PATH: '/usr/local/bin/codex',
            RERUN_WEB_SEARCH_FALLBACK: 'mwmbl',
        })
    })

    it('reads an empty hub URL as no hub, but keeps an empty API key', async () => {
        const env = await freshEnv({ RERUN_HUB_BASE_URL: '', RERUN_API_KEY: '' })
        expect(env().RERUN_HUB_BASE_URL).toBeUndefined()
        expect(env().RERUN_API_KEY).toBe('')
    })

    it('refuses an invalid hub URL, port or log level, naming the variable', async () => {
        await expect(freshEnv({ RERUN_HUB_BASE_URL: 'not a url' }).then(env => env())).rejects.toThrow(/^Invalid environment: RERUN_HUB_BASE_URL/)
        await expect(freshEnv({ RERUN_PORT: 'eighty' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
        await expect(freshEnv({ RERUN_PORT: '-1' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
        await expect(freshEnv({ RERUN_PORT: '80.5' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
        await expect(freshEnv({ RERUN_LOG_LEVEL: 'verbose' }).then(env => env())).rejects.toThrow(/RERUN_LOG_LEVEL/)
        await expect(freshEnv({ RERUN_WEB_SEARCH_FALLBACK: 'other' }).then(env => env())).rejects.toThrow(/RERUN_WEB_SEARCH_FALLBACK/)
    })

    it('reads an empty port as 0 and refuses it', async () => {
        await expect(freshEnv({ RERUN_PORT: '' }).then(env => env())).rejects.toThrow(/RERUN_PORT/)
    })

    it('parses once and serves the cached value afterwards', async () => {
        const env = await freshEnv({ RERUN_PORT: '4000' })
        const first = env()
        vi.stubEnv('RERUN_PORT', '5000')
        expect(env()).toBe(first)
        expect(env().RERUN_PORT).toBe(4000)
    })

    it('does not cache a failed parse', async () => {
        const env = await freshEnv({ RERUN_LOG_LEVEL: 'verbose' })
        expect(() => env()).toThrow()
        vi.stubEnv('RERUN_LOG_LEVEL', 'warn')
        expect(env().RERUN_LOG_LEVEL).toBe('warn')
    })
})
