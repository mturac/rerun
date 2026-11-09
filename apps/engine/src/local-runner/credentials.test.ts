import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { announceRunner, isValidAnnounceUrl, issueRunnerCredential, runnerTargets } from './credentials.js'

describe('isValidAnnounceUrl', () => {
    it('accepts http(s) URLs with a host', () => {
        expect(isValidAnnounceUrl('http://127.0.0.1:4700')).toBe(true)
        expect(isValidAnnounceUrl('https://runner.example.com')).toBe(true)
        expect(isValidAnnounceUrl('http://192.168.1.5:4700/base')).toBe(true)
    })

    it('rejects unparseable, host-less and non-http(s) URLs', () => {
        expect(isValidAnnounceUrl('not a url')).toBe(false)
        expect(isValidAnnounceUrl('ftp://example.com')).toBe(false)
        expect(isValidAnnounceUrl('file:///etc/passwd')).toBe(false)
        expect(isValidAnnounceUrl('http://')).toBe(false)
        expect(isValidAnnounceUrl('')).toBe(false)
    })
})

describe('announceRunner URL validation', () => {
    it('stores a valid announce and rejects an invalid one without touching the record', () => {
        const dir = mkdtempSync(join(tmpdir(), 'rerun-lr-cred-'))
        const { credential } = issueRunnerCredential(dir, 'test')
        expect(announceRunner(dir, credential.id, { url: 'javascript:alert(1)', token: 'rlrs_abcdefgh' })).toBe(false)
        expect(runnerTargets(dir)).toHaveLength(0)
        expect(announceRunner(dir, credential.id, { url: 'http://127.0.0.1:4700', token: 'rlrs_abcdefgh' })).toBe(true)
        expect(runnerTargets(dir)).toHaveLength(1)
        expect(runnerTargets(dir)[0].url).toBe('http://127.0.0.1:4700')
    })
})
