import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const paths = Object.fromEntries(['bot', 'config', 'state', 'blacklist', 'image-generation', 'usage'].map(name => [name, JSON.stringify(join(import.meta.dir, `../bot/${name}.ts`))]))

test('an image generated on the api backend is uploaded with the bot reply', () => {
    const script = `
        import { spyOn } from 'bun:test'
        import { rmSync, mkdtempSync } from 'node:fs'
        import { tmpdir } from 'node:os'
        import { join } from 'node:path'
        import { Database } from 'bun:sqlite'
        import { Message, ChannelType } from 'discord.js'
        import { createBot } from ${paths.bot}
        import { createConfig } from ${paths.config}
        import { createState } from ${paths.state}
        import { createBlacklist } from ${paths.blacklist}
        import { createUsage } from ${paths.usage}
        import { createImageGeneration } from ${paths['image-generation']}

        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
        const directory = mkdtempSync(join(tmpdir(), 'gork-image-reply-'))
        const config = createConfig(createState(directory)).config
        config.backend = 'api'
        config.image.size = '1024x1024'
        config.image.quality = 'low'
        process.env.OPENAI_API_KEY = 'integration-key'

        const originalFetch = globalThis.fetch
        const imageRequests = []
        globalThis.fetch = (async (url, init) => {
            if (String(url).startsWith('https://api.openai.com/')) {
                imageRequests.push({ url: String(url), body: JSON.parse(init.body) })
                return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } })
            }
            return originalFetch(url, init)
        })

        const own = { id: '999999999999999999', username: 'receiver', discriminator: '0', bot: true }
        const human = { id: '777777777777777777', username: 'human', discriminator: '0', bot: false }
        const guildId = '666666666666666666', channelId = '555555555555555555'
        const uploads = []
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            const url = new URL(request.url)
            if (request.method === 'GET') return Response.json([])
            if (url.pathname.endsWith('/typing')) return new Response(null, { status: 204 })
            const raw = new Uint8Array(await request.arrayBuffer())
            const text = new TextDecoder('latin1').decode(raw)
            const signature = [0x89, 0x50, 0x4e, 0x47]
            let hasPngBytes = false
            for (let i = 0; i <= raw.length - 4; i++) {
                if (signature.every((byte, offset) => raw[i + offset] === byte)) { hasPngBytes = true; break }
            }
            uploads.push({ bytes: raw.byteLength, hasPngBytes, filenames: [...text.matchAll(/filename="([^"]+)"/g)].map(match => match[1]) })
            return Response.json({ id: '1000', channel_id: channelId, guild_id: guildId, author: own, content: 'here you go',
                timestamp: '2026-11-11T00:00:00Z', type: 0, mentions: [], mention_roles: [], mention_everyone: false, embeds: [], flags: 0,
                attachments: [{ id: 'a', filename: 'generated-1.png', size: png.length, url: 'https://x/y.png', proxy_url: 'https://x/y.png' }] })
        } })

        const bot = createBot({ config, blacklist: createBlacklist(directory, config) })
        const { client } = bot
        client.user = client.users._add(own)
        client.rest.options.api = server.url.origin
        client.rest.setToken('integration-token')
        const guild = client.guilds._add({ id: guildId, name: 'integration', owner_id: human.id, roles: [{ id: guildId, name: '@everyone', permissions: '0' }] })
        client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: 'integration', permission_overwrites: [] }, guild)
        const login = spyOn(client, 'login').mockResolvedValue('integration-token')
        const usage = createUsage(directory)
        bot.message(async chat => {
            await createImageGeneration({ config, track: usage.trackCodexTurn, trackImage: usage.trackImage })
                .run({ prompt: 'draw a dot', action: 'generate', size: 'auto', quality: 'auto' }, chat)
            return 'here you go'
        })
        bot.ready('integration-token')
        const onMessage = client.listeners('messageCreate')[0]
        const msg = new Message(client, { id: '1001', channel_id: channelId, guild_id: guildId, author: human,
            content: '<@' + own.id + '> draw a dot', timestamp: '2026-11-11T00:00:00Z', type: 0, mentions: [own],
            mention_roles: [], mention_everyone: false, attachments: [], embeds: [], flags: 0 })
        await onMessage(msg)
        const db = new Database(join(directory, 'usage.sqlite'), { readonly: true })
        const rows = db.query('SELECT source, provider, status, requested_model, total_tokens FROM usage_requests').all()
        db.close()
        login.mockRestore()
        await client.destroy()
        server.stop(true)
        rmSync(directory, { recursive: true, force: true })
        console.log(JSON.stringify({ uploads, imageRequests, rows }))
    `
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 20000,
        env: { ...process.env, CODEX_BIN: '/nonexistent-codex-binary', OPENAI_API_KEY: '' },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    expect(output.imageRequests).toEqual([{ url: 'https://api.openai.com/v1/images/generations', body: { model: 'gpt-image-2.6-flare', prompt: 'draw a dot', size: '1024x1024', quality: 'low', n: 1 } }])
    expect(output.uploads).toHaveLength(1)
    expect(output.uploads[0].hasPngBytes).toBe(true)
    expect(output.uploads[0].filenames).toEqual(['generated-1.png'])
    expect(output.rows).toEqual([{ source: 'image-generation', provider: 'openai', status: 'completed', requested_model: 'gpt-image-2.6-flare', total_tokens: 12 }])
})
