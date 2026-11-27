import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReplyLimits, defaultReplyLimit } from '../bot/reply-limits.ts'
import { createReplyRateLimit, ownerUserId } from '../bot/reply-rate-limit.ts'
import { createConfig, defaultConfig } from '../bot/config.ts'
import { createState } from '../bot/state.ts'

test('channel reply limits persist per instance and fall back to 140 characters', () => {
    const directory = mkdtempSync(join(tmpdir(), 'clod-reply-limits-'))
    try {
        const first = createReplyLimits(directory)
        expect(defaultReplyLimit).toBe(140)
        expect(first.forChannel('default-channel')).toBe(140)
        expect(first.set('off-topic', 700)).toContain('700')
        expect(first.forChannel('off-topic')).toBe(700)
        expect(first.forChannel('default-channel')).toBe(140)

        const persisted = JSON.parse(readFileSync(join(directory, 'reply-limits.json'), 'utf8'))
        expect(persisted).toEqual({ 'off-topic': 700 })
        const afterRestart = createReplyLimits(directory)
        expect(afterRestart.forChannel('off-topic')).toBe(700)
        expect(afterRestart.view()).toBe('default: 140; overrides: {"off-topic":700}')
        expect(afterRestart.reset('off-topic')).toContain('default 140')
        expect(createReplyLimits(directory).forChannel('off-topic')).toBe(140)
        expect(afterRestart.set('off-topic', 1991)).toContain('between 1 and 1990')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('reply triggers use a configurable rolling window and exempt the owner', () => {
    let now = 0
    const allow = createReplyRateLimit(() => now)
    const config = defaultConfig.reply_rate_limit
    expect(config).toEqual({ messages: 3, window_seconds: 60 })
    expect(allow('user', config.messages, config.window_seconds)).toBe(true)
    now = 20_000
    expect(allow('user', config.messages, config.window_seconds)).toBe(true)
    now = 40_000
    expect(allow('user', config.messages, config.window_seconds)).toBe(true)
    now = 50_000
    expect(allow('user', config.messages, config.window_seconds)).toBe(false)
    now = 60_001
    expect(allow('user', config.messages, config.window_seconds)).toBe(true)
    expect(allow(ownerUserId, config.messages, config.window_seconds)).toBe(true)

    const directory = mkdtempSync(join(tmpdir(), 'clod-rate-config-'))
    try {
        const settings = createConfig(createState(directory))
        expect(settings.setConfig({ key: 'reply_rate_limit.messages', value: '5' })).toContain('5')
        expect(settings.setConfig({ key: 'reply_rate_limit.window_seconds', value: '90' })).toContain('90')
        expect(settings.config.reply_rate_limit).toEqual({ messages: 5, window_seconds: 90 })
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
