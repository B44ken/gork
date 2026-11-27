import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexFixture } from './fixtures/setup.ts'

const root = join(import.meta.dir, '..')
const owner = '143771295832735745', alice = '234567890123456789', bob = '345678901234567890'

test('Discord commands, memory context, persona tools and owner permissions use the current Codex transport', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muoft-persona-'))
    try {
        symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
        for (const name of ['bot', 'site', 'tests']) cpSync(join(root, name), join(dir, name), { recursive: true })
        for (const name of ['README.md', 'package.json']) cpSync(join(root, name), join(dir, name))
        writeFileSync(join(dir, 'db.json'), JSON.stringify({ config: {}, facts: { [alice]: ['alice memory'], [bob]: ['bob memory'] } }))
        writeFileSync(join(dir, 'reply-limits.json'), JSON.stringify({ '555555555555555555': 400 }))
        const executable = codexFixture(dir, [
            { text: 'x'.repeat(500) },
            { tools: [
                { name: 'set-persona', arguments: { content: 'changed persona' } },
                { name: 'view-persona', arguments: {} },
                { name: 'list-source', arguments: {} },
                { name: 'read-source', arguments: { path: '.env.local' } },
                { name: 'discord-repl', arguments: { code: 'throw new Error("must not execute")' } },
            ] },
            { text: 'third response' },
            { tools: [{ name: 'read-source', arguments: { path: 'bot/config.ts' } }], text: 'agent response' },
            { tools: [{ name: 'discord-repl', arguments: { code: 'return client.user.username' } }] },
        ])
        const script = `
            import { spyOn } from 'bun:test';
            import { Message, ChannelType } from 'discord.js';
            import { createInstance } from ${JSON.stringify(join(root, 'bot/instance.ts'))};
            const instance = createInstance({ name: 'test', directory: '.', port: 0 });
            const bot = instance.bot, config = instance.config.config;
            config.moderation.enabled = false; config.waffle.chance = 0;
            const own = { id: '999999999999999999', username: 'receiver', discriminator: '0', bot: true };
            const user = id => ({ id, username: 'same-name', discriminator: '0', bot: false });
            bot.client.user = bot.client.users._add(own);
            bot.client.application = { owner: { id: '${owner}' } };
            const guildId = '666666666666666666', channelId = '555555555555555555';
            const guild = bot.client.guilds._add({ id: guildId, name: 'test', owner_id: '${owner}', roles: [{ id: guildId, name: '@everyone', permissions: '0' }] });
            bot.client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: 'test', permission_overwrites: [] }, guild);
            let nextId = 1000000000000000000n;
            const payload = (author, content) => ({ id: String(nextId++), channel_id: channelId, guild_id: guildId, author, content, timestamp: '2026-11-12T00:00:00Z', type: 0, mentions: [], mention_roles: [], mention_everyone: false, attachments: [], embeds: [], flags: 0 });
            const history = [payload(user('${bob}'), 'recent history'), payload(own, 'the operation was a success:)'), payload(user('${alice}'), 'old history')];
            const replies = [], queries = [];
            const server = Bun.serve({ port: 0, async fetch(request) {
                const url = new URL(request.url);
                if (request.method === 'GET' && url.pathname.includes('/members/')) {
                    const id = url.pathname.split('/').at(-1);
                    return Response.json({ user: user(id), nick: id === '${alice}' ? 'Alice' : 'Bob', roles: [], joined_at: '2024-01-01T00:00:00Z' });
                }
                if (request.method === 'GET') { queries.push(url.search); return Response.json(history) }
                if (url.pathname.endsWith('/typing')) return new Response(null, { status: 204 });
                const body = await request.json(); replies.push(body); return Response.json(payload(own, body.content));
            } });
            bot.client.rest.options.api = server.url.origin; bot.client.rest.setToken('fixture-token');
            spyOn(bot.client, 'login').mockResolvedValue('fixture-token');
            instance.start('fixture-token');
            const command = bot.client.listeners('interactionCreate')[0], onMessage = bot.client.listeners('messageCreate')[0];
            const persona = async (subcommand, prompt, id = '${alice}') => {
                let result;
                await command({ isChatInputCommand: () => true, commandName: 'persona', user: user(id), channel: {},
                    options: { getSubcommandGroup: () => null, getSubcommand: () => subcommand, getString: () => prompt },
                    reply: async value => result = value.content, deferReply: async () => {}, editReply: async value => result = value.content });
                return result;
            };
            const deniedPersona = await persona('set', 'unauthorized persona');
            const publicView = await persona('view');
            await persona('set', 'initial persona limit={limit} {facts}', '${owner}');
            const invalid = await persona('set', ' ', '${owner}'), afterInvalid = await persona('view');
            let configDenied;
            await command({ isChatInputCommand: () => true, commandName: 'gork', user: user('${alice}'), channel: {},
                options: { getSubcommandGroup: () => 'config', getSubcommand: () => 'thinking', getString: () => 'max' },
                reply: async value => configDenied = value.content });
            const deniedThinking = config.thinking;
            let configAllowed;
            await command({ isChatInputCommand: () => true, commandName: 'gork', user: user('${owner}'), channel: {},
                options: { getSubcommandGroup: () => 'config', getSubcommand: () => 'thinking', getString: () => 'max' },
                reply: async value => configAllowed = value.content });
            const allowedThinking = config.thinking;
            for (let i = 0; i < 3; i++) await onMessage(new Message(bot.client, payload(user('${alice}'), '<@' + own.id + '> hello')));
            const investigation = await instance.agent.run('read the config');
            const ai = instance.ai;
            const ownerMessage = new Message(bot.client, payload(user('${owner}'), 'read bot username'));
            await ai.get({ message: ownerMessage, history: [], next: { id: '${owner}', name: 'owner', msg: 'read bot username' }, channel: 'test' }, 'system', { id: '${owner}', name: 'owner', msg: 'read bot username' });
            const reset = await persona('reset', undefined, '${owner}');
            await instance.stop();
            server.stop(true);
            console.log(JSON.stringify({ replies, queries, deniedPersona, publicView, invalid, afterInvalid, configDenied, deniedThinking, configAllowed, allowedThinking, investigation, reset }));
        `
        const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, DISCORD_TOKEN: 'fixture-token', EXA_API_KEY: 'fixture-key', CODEX_BIN: executable }, encoding: 'utf8', timeout: 10000 })
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
        const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
        expect(output.deniedPersona).toContain('only the owner')
        expect(output.publicView).toContain('your messages must be brief.')
        expect(output.publicView).not.toBe('unauthorized persona')
        expect(output.invalid).toContain('between 1 and 1800')
        expect(output.afterInvalid).toBe('initial persona limit={limit} {facts}')
        expect(output.configDenied).toContain('only the owner')
        expect(output.deniedThinking).toBe('low')
        expect(output.configAllowed).toBe('set config.thinking=max')
        expect(output.allowedThinking).toBe('max')
        expect(output.replies.map((reply: any) => reply.content)).toEqual(['x'.repeat(400), 'done', 'third response'])
        expect(output.replies.every((reply: any) => reply.allowed_mentions.replied_user === false)).toBe(true)
        expect(output.queries.every((query: string) => query.includes('before=') && query.includes('limit='))).toBe(true)
        expect(output.investigation).toBe('agent response')
        expect(output.reset).toContain('reset')
        const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const threads = events.filter(event => event.method === 'thread/start').map(event => event.params)
        const turns = events.filter(event => event.method === 'turn/start').map(event => event.params)
        expect(threads[0].baseInstructions).toContain('initial persona')
        expect(threads[0].baseInstructions).toContain('limit=400')
        expect(threads[0].baseInstructions).toContain('limit each text reply to 400 characters.')
        expect(threads[0].baseInstructions).toContain('id: ' + alice + ', username: same-name, display name: Alice')
        expect(threads[0].baseInstructions).toContain('id: ' + bob + ', username: same-name, display name: Bob')
        expect(threads[0].baseInstructions).not.toContain('{facts}')
        expect(turns[0].input[0].text).toContain('recent history')
        expect(turns[0].input[0].text).not.toContain('old history')
        expect(threads[0].dynamicTools.map((tool: any) => tool.name)).not.toContain('discord-repl')
        expect(threads[3].dynamicTools.map((tool: any) => tool.name)).toEqual(['list-source', 'read-source'])
        expect(threads[4].dynamicTools.map((tool: any) => tool.name)).toContain('discord-repl')
        expect(threads.every(thread => thread.config.features.shell_tool === false && thread.config.web_search === 'disabled')).toBe(true)
        const results = events.filter(event => event.id >= 100 && event.result).map(event => event.result.contentItems[0].text)
        expect(results).toContain(JSON.stringify('source file not found: .env.local'))
        expect(results).toContain(JSON.stringify('persona updated; it will apply to subsequent requests'))
        expect(results).toContain(JSON.stringify('tool unavailable for this sender; only the owner can use owner-only tools'))
        expect(results).toContain(JSON.stringify(JSON.stringify('receiver')))
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
