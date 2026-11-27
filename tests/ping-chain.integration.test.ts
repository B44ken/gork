import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const paths = Object.fromEntries(['bot', 'config', 'state', 'blacklist'].map(name => [name, JSON.stringify(join(import.meta.dir, `../bot/${name}.ts`))]))

test('stops a bot ping chain six messages deep while humans always get an answer', () => {
    const script = `
        import { spyOn } from 'bun:test'
        import { rmSync, mkdtempSync } from 'node:fs'
        import { tmpdir } from 'node:os'
        import { join } from 'node:path'
        import { Message, ChannelType } from 'discord.js'
        import { createBot } from ${paths.bot}
        import { createConfig } from ${paths.config}
        import { createState } from ${paths.state}
        import { createBlacklist } from ${paths.blacklist}
        const directory = mkdtempSync(join(tmpdir(), 'gork-thread-'))
        const config = createConfig(createState(directory)).config
        config.waffle.chance = 0
        const { client, message, ready } = createBot({ config, blacklist: createBlacklist(directory, config) })
        const own = { id: '999999999999999999', username: 'receiver', discriminator: '0', bot: true }
        const other = { id: '888888888888888888', username: 'sender', discriminator: '0', bot: true }
        const human = { id: '777777777777777777', username: 'human', discriminator: '0', bot: false }
        const guildId = '666666666666666666', channelId = '555555555555555555', roleId = '444444444444444444'
        client.user = client.users._add(own)
        const guild = client.guilds._add({ id: guildId, name: 'integration', owner_id: human.id, roles: [
            { id: guildId, name: '@everyone', permissions: '0' },
            { id: roleId, name: 'receiver', permissions: '0' },
        ] })
        guild.members._add({ user: own, roles: [roleId], joined_at: '2024-01-01T00:00:00Z' })
        client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: 'integration', permission_overwrites: [] }, guild)
        let id = 1000000000000000000n
        const log = []
        const byId = value => log.find(entry => entry.id === value)
        const payload = (author, content, extras = {}) => {
            const data = {
                id: String(id++), channel_id: channelId, guild_id: guildId, author, content,
                timestamp: '2026-11-11T00:00:00Z', type: 0, mentions: [], mention_roles: [],
                mention_everyone: false, attachments: [], embeds: [], flags: 0, ...extras,
            }
            log.push(data)
            return data
        }
        const replyTo = (author, parent, content) => payload(author, content, {
            type: 19, message_reference: { message_id: parent.id, channel_id: channelId, guild_id: guildId },
            referenced_message: parent,
        })
        const received = [], replies = []
        let lastReply
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
            const url = new URL(request.url)
            if (request.method === 'GET') {
                const single = url.pathname.match(/\\/messages\\/(\\d+)$/)
                if (single) {
                    const found = byId(single[1])
                    return found ? Response.json(found) : Response.json({ code: 10008, message: 'Unknown Message' }, { status: 404 })
                }
                if (!url.pathname.endsWith('/messages')) return Response.json([])
                const before = url.searchParams.get('before')
                const limit = Number(url.searchParams.get('limit') ?? 50)
                const list = log.slice().reverse().filter(entry => !before || BigInt(entry.id) < BigInt(before))
                return Response.json(list.slice(0, limit))
            }
            if (url.pathname.endsWith('/typing')) return new Response(null, { status: 204 })
            const body = await request.json()
            replies.push(body)
            const parent = byId(body.message_reference?.message_id)
            lastReply = payload(own, body.content, {
                type: 19, message_reference: { message_id: parent.id, channel_id: channelId, guild_id: guildId },
                referenced_message: parent,
            })
            return Response.json(lastReply)
        } })
        client.rest.options.api = server.url.origin
        client.rest.setToken('integration-token')
        const login = spyOn(client, 'login').mockResolvedValue('integration-token')
        message(async chat => { received.push(chat.next.msg); return 'answer: ' + chat.next.msg })
        ready('integration-token')
        const onMessage = client.listeners('messageCreate')[0]
        await onMessage(new Message(client, payload(human, '<@' + own.id + '> human ping', { mentions: [own] })))
        await onMessage(new Message(client, replyTo(other, lastReply, 'bot reply 1')))
        await onMessage(new Message(client, replyTo(other, lastReply, 'bot reply 2')))
        await onMessage(new Message(client, replyTo(other, lastReply, 'bot reply 3')))
        await onMessage(new Message(client, replyTo(human, lastReply, 'human follow up')))
        console.log(JSON.stringify({ received, replies }))
        login.mockRestore()
        await client.destroy()
        server.stop(true)
        rmSync(directory, { recursive: true, force: true })
    `
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, DISCORD_TOKEN: 'integration-token' },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    // Bot runs are 2, 4 and 6 for the three bot replies, so the third is past the cap.
    // The human message starts a run of zero and is answered even that deep in the thread.
    expect(output.received).toEqual([
        '<@999999999999999999> human ping',
        'bot reply 1',
        'bot reply 2',
        'human follow up',
    ])
    expect(output.replies).toHaveLength(4)
})
