import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const paths = Object.fromEntries(['bot', 'config', 'state', 'blacklist'].map(name => [name, JSON.stringify(join(import.meta.dir, `../bot/${name}.ts`))]))

test('bot mentions without pings reach the message handler and send real Discord.js replies over HTTP', () => {
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
        const directory = mkdtempSync(join(tmpdir(), 'gork-mentions-'))
        const config = createConfig(createState(directory)).config
        config.waffle.chance = 0
        const { client, message, ready } = createBot({ config, blacklist: createBlacklist(directory, config) })
        const own = { id: '999999999999999999', username: 'receiver', discriminator: '0', bot: true }
        const other = { id: '888888888888888888', username: 'sender', discriminator: '0', bot: true }
        const human = { id: '777777777777777777', username: 'human', discriminator: '0', bot: false }
        const guildId = '666666666666666666', channelId = '555555555555555555', targetChannelId = '859194490577092657', roleId = '444444444444444444'
        client.user = client.users._add(own)
        const guild = client.guilds._add({ id: guildId, name: 'integration', owner_id: human.id, roles: [
            { id: guildId, name: '@everyone', permissions: '0' },
            { id: roleId, name: 'receiver', permissions: '0' },
        ] })
        guild.members._add({ user: own, roles: [roleId], joined_at: '2024-01-01T00:00:00Z' })
        client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: 'integration', permission_overwrites: [] }, guild)
        client.channels._add({ id: targetChannelId, guild_id: guildId, type: ChannelType.GuildText, name: 'redirect-target', permission_overwrites: [] }, guild)
        let id = 1000000000000000000n
        const payload = (author, content, mentions = [], roles = []) => ({
            id: String(id++), channel_id: channelId, guild_id: guildId, author, content,
            timestamp: '2026-11-11T00:00:00Z', type: 0, mentions, mention_roles: roles,
            mention_everyone: false, attachments: [], embeds: [], flags: 0,
        })
        const replies = [], received = [], detected = [], messageIds = []
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
            const path = new URL(request.url).pathname
            if (request.method === 'GET') return Response.json([])
            if (path.endsWith('/typing')) return new Response(null, { status: 204 })
            const body = await request.json()
            replies.push(body)
            return Response.json(payload(own, body.content))
        } })
        client.rest.options.api = server.url.origin
        client.rest.setToken('integration-token')
        const login = spyOn(client, 'login').mockResolvedValue('integration-token')
        message(async chat => { received.push(chat.next.msg); return 'answer: ' + chat.next.msg })
        ready('integration-token')
        const onMessage = client.listeners('messageCreate')[0]
        for (const data of [
            payload(other, '<@' + own.id + '> hello'),
            payload(other, '<@!' + own.id + '> hello again'),
            payload(human, '<@' + own.id + '> human mention', [own]),
            payload(other, '<@&' + roleId + '> role mention', [], [roleId]),
            payload(other, '<@' + human.id + '> someone else'),
            payload(other, '@everyone unrelated'),
            payload(own, '<@' + own.id + '> self'),
        ]) {
            const msg = new Message(client, data)
            messageIds.push(msg.id)
            detected.push({ parsed: msg.mentions.parsedUsers.has(own.id), notified: msg.mentions.has(own, { ignoreEveryone: true }) })
            await onMessage(msg)
        }
        config.waffle.chance = 1
        const targetUnprompted = new Message(client, { ...payload(human, 'unprompted in redirect channel'), channel_id: targetChannelId })
        messageIds.push(targetUnprompted.id); await onMessage(targetUnprompted)
        const targetMention = new Message(client, { ...payload(human, '<@' + own.id + '> redirect me', [own]), channel_id: targetChannelId })
        messageIds.push(targetMention.id); await onMessage(targetMention)
        const ordinaryUnprompted = new Message(client, payload(human, 'unprompted in ordinary channel'))
        messageIds.push(ordinaryUnprompted.id); await onMessage(ordinaryUnprompted)
        const rateLimited = new Message(client, payload(human, '<@' + own.id + '> over the limit', [own]))
        messageIds.push(rateLimited.id); await onMessage(rateLimited)
        const owner = { id: '143771295832735745', username: 'b4444', discriminator: '0', bot: false }
        const ownerMention = new Message(client, payload(owner, '<@' + own.id + '> owner exemption', [own]))
        messageIds.push(ownerMention.id); await onMessage(ownerMention)
        console.log(JSON.stringify({ received, replies, detected, messageIds }))
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
    expect(output.detected[0]).toEqual({ parsed: true, notified: false })
    expect(output.detected[1]).toEqual({ parsed: true, notified: false })
    expect(output.received).toEqual([
        '<@999999999999999999> hello',
        '<@!999999999999999999> hello again',
        '<@999999999999999999> human mention',
        '<@&444444444444444444> role mention',
        'unprompted in ordinary channel',
        '<@999999999999999999> owner exemption',
    ])
    expect(output.replies.map((reply: any) => reply.content)).toEqual([
        ...output.received.slice(0, 4).map((content: string) => 'answer: ' + content),
        'plz use <#859205331455705128>',
        'answer: unprompted in ordinary channel',
        'answer: <@999999999999999999> owner exemption',
    ])
    for (const [index, reply] of output.replies.entries()) {
        expect(reply.allowed_mentions).toEqual({ parse: [], replied_user: false })
        if (index < 4) expect(reply.message_reference.message_id).toBe(output.messageIds[index])
    }
})
