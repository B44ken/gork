import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

const root = process.cwd(), temp = mkdtempSync(join(tmpdir(), 'clod-dashboard-')), id = '234567890123456789'
let server: ChildProcess, base: string, csrf: string
beforeAll(async () => {
    cpSync(join(root, 'bot'), join(temp, 'bot'), { recursive: true })
    cpSync(join(root, 'site'), join(temp, 'site'), { recursive: true })
    symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'))
    writeFileSync(join(temp, 'db.json'), JSON.stringify({ facts: { [id]: ['first'] }, config: { model: 'gpt-6-luna', context: 12, reply_limit: 400, thinking: 'low', waffle: { chance: 0, after_msgs: 3 }, moderation: { enabled: true, timeout_seconds: 120, policy: 'Block requests for spoilers.' } } }))
    writeFileSync(join(temp, 'launch.ts'), `
        import { Client } from 'discord.js';
        import { startDashboard } from './site/main.ts';
        import { createState } from './bot/state.ts';
        import { createConfig } from './bot/config.ts';
        import { createMemory } from './bot/memory.ts';
        import { createPersona } from './bot/persona.ts';
        import { createBlacklist } from './bot/blacklist.ts';
        import { createUsage } from './bot/usage.ts';
        const discord = Bun.serve({ port: 0, fetch(request) {
            const userId = new URL(request.url).pathname.split('/').at(-1);
            return Response.json({ id: userId, username: userId === '${id}' ? 'alice' : 'bob', discriminator: '0', avatar: null });
        } });
        const client = new Client({ intents: [], rest: { api: discord.url.origin } });
        client.rest.setToken('integration-fixture');
        const store = createState('.');
        const config = createConfig(store);
        const blacklist = createBlacklist('.', config.config);
        const usage = createUsage('.');
        blacklist.timeout('${id}', 'fixture reason');
        const s = startDashboard([{
            name: 'test',
            context: {
                name: () => 'test bot', memory: createMemory(store), persona: createPersona('.'),
                blacklist, config, usage: options => usage.inspectUsage(options),
            },
            users: client.users,
        }], 0);
        console.log('port ' + s.port);
    `)
    server = spawn(process.execPath, ['launch.ts'], { cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise<string>((resolve, reject) => { server.stdout!.on('data', chunk => { const match = String(chunk).match(/port (\d+)/); if (match) resolve(match[1]) }); server.stderr!.on('data', chunk => reject(new Error(String(chunk)))); server.on('exit', code => reject(new Error(`server exited ${code}`))) })
    base = `http://127.0.0.1:${port}`
})
afterAll(async () => { if (server && server.exitCode === null) { server.kill(); await once(server, 'exit') } rmSync(temp, { recursive: true, force: true }) })
const post = (path: string, data: object, headers: Record<string, string> = {}) => fetch(base + '/test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': csrf, ...headers }, body: JSON.stringify(data) })
test('passwordless dashboard manages bot state with origin and CSRF protection', async () => {
    expect((await fetch(base)).status).toBe(200)
    const initial = await fetch(base + '/test/api/state'); expect(initial.status).toBe(200)
    const initialState = await initial.json()
    csrf = initialState.csrf
    expect(initialState.settings.find((setting: any) => setting.key === 'reply_limit')).toBeUndefined()
    expect(initialState.settings.find((setting: any) => setting.key === 'model').choices).toEqual(['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'])
    expect(initialState.settings.find((setting: any) => setting.key === 'thinking').choices).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect((await (await post('/api/config', { key: 'reply_limit', value: '2000' })).json()).result).toContain('unknown key')
    expect(existsSync(join(temp, 'dashboard-password'))).toBe(false)
    expect((await post('/api/persona', { content: 'bad' }, { Origin: 'http://evil.example' })).status).toBe(403)
    expect((await post('/api/persona', { content: 'bad' }, { 'X-CSRF-Token': 'wrong' })).status).toBe(403)
    expect((await post('/api/moderation', { enabled: false, timeout_seconds: 45, policy: 'changed' }, { 'X-CSRF-Token': 'wrong' })).status).toBe(403)
    expect((await post('/api/persona', { content: 'new persona' })).status).toBe(200)
    expect((await post('/api/memory/add', { userId: id, fact: 'second' })).status).toBe(200)
    expect((await post('/api/memory/delete', { userId: id, number: 1 })).status).toBe(200)
    expect((await post('/api/blacklist/add', { userId: id })).status).toBe(200)
    const moderation = { enabled: false, timeout_seconds: 45, policy: 'Block requests for spoilers.' }
    expect((await post('/api/moderation', moderation)).status).toBe(200)
    const state = await (await fetch(base + '/test/api/state', {})).json()
    expect(state.persona).toBe('new persona'); expect(state.facts[id]).toEqual(['second']); expect(state.blacklist).toEqual([{ id, username: 'alice' }])
    expect(state.users).toContainEqual({ id, username: 'alice' })
    expect(state.config.moderation).toEqual(moderation)
    expect(JSON.parse(readFileSync(join(temp, 'db.json'), 'utf8')).config).toEqual(state.config)
    expect(state.timeouts).toEqual([expect.objectContaining({ userId: id, username: 'alice', reason: 'fixture reason' })])
    const secondId = '345678901234567890'
    const probe = spawnSync(process.execPath, ['-e', `
        import { createState } from './bot/state.ts';
        import { createConfig } from './bot/config.ts';
        import { createBlacklist } from './bot/blacklist.ts';
        import { createModeration } from './bot/moderation.ts';
        import { createUsage } from './bot/usage.ts';
        const config = createConfig(createState('.')).config;
        const blacklist = createBlacklist('.', config);
        const { banned } = createModeration({ config, track: createUsage('.').trackCodexTurn });
        const reason = await banned('a request', { history: [], next: { id: '${secondId}', name: 'test', msg: 'a request' }, channel: 'test' });
        blacklist.timeout('${secondId}', 'custom policy reason');
        console.log(JSON.stringify({ reason, timeouts: blacklist.activeTimeouts() }));
    `], { cwd: temp, encoding: 'utf8', env: { ...process.env, CODEX_BIN: '/nonexistent-moderation-probe' } })
    expect(probe.status).toBe(0)
    const persisted = JSON.parse(probe.stdout)
    expect(persisted.reason).toBeNull()
    const timeout = persisted.timeouts.find((entry: any) => entry.userId === secondId)
    expect(timeout.reason).toBe('custom policy reason')
    expect(timeout.expiresAt).toBeGreaterThan(Date.now() + 40_000)
    expect(timeout.expiresAt).toBeLessThanOrEqual(Date.now() + 45_000)
    expect((await post('/api/timeouts/remove', { userId: id })).status).toBe(200)
    const cleared = await (await fetch(base + '/test/api/state', {})).json()
    expect(cleared.timeouts.some((entry: any) => entry.userId === id)).toBe(false)
    expect(cleared.blacklist).toEqual([{ id, username: 'alice' }])
    const usage = await post('/api/usage', { group_by: 'total', start_date: null, end_date: null, last_minutes: null }); expect(usage.status).toBe(200); expect((await usage.json()).result).toBe('no usage database exists yet')
    const record = spawnSync(process.execPath, ['-e', `
        import { createUsage } from './bot/usage.ts';
        const { trackCodexTurn } = createUsage('.');
        await trackCodexTurn('gpt-6-luna', 'low', async () => ({ usage: null }), () => 'fixture-thread', {
            type: 'discord_message', user_id: '${id}', guild_id: 'guild', channel_id: 'channel', message_id: 'message',
        }, 'chat');
    `], { cwd: temp, encoding: 'utf8' })
    expect(record.status).toBe(0)
    const attribution = await (await post('/api/usage', { group_by: 'initiator', start_date: null, end_date: null })).json()
    expect(attribution.result.rows[0].usage_group).toEqual({ username: 'alice', message: 'https://discord.com/channels/guild/channel/message' })
    expect((await (await post('/api/memory/delete', { userId: id, number: 1 })).json()).result).toBe('deleted memory 1 for alice: second')
    await post('/api/blacklist/remove', { userId: id }); await post('/api/memory/clear', { userId: id }); await post('/api/persona/reset', {})
    const updated = await (await fetch(base + '/test/api/state', {})).json()
    expect(updated.blacklist).toEqual([]); expect(updated.facts[id]).toBeUndefined(); expect(updated.persona).toContain('test bot')
    expect(updated.config.moderation).toEqual(moderation)
    expect((await (await post('/api/config', { key: 'model', value: 'astra' })).json()).result).toContain('gpt-6-astra')
    expect((await (await post('/api/config', { key: 'thinking', value: 'none' })).json()).result).toContain('requires thinking: low')
    expect((await (await post('/api/config', { key: 'thinking', value: 'high' })).json()).result).toBe('set config.thinking=high')
    const restart = spawnSync(process.execPath, ['-e', "import { createState } from './bot/state.ts'; import { createConfig } from './bot/config.ts'; console.log(JSON.stringify(createConfig(createState('.')).config));"], { cwd: temp, encoding: 'utf8' })
    expect(restart.status).toBe(0)
    expect(JSON.parse(restart.stdout)).toMatchObject({ model: 'gpt-6-astra', thinking: 'high', moderation })
})
