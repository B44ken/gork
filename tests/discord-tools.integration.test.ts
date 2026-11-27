import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
const originalDir = join(import.meta.dir, '..')
const ownerId = '143771295832735745', otherId = '234567890123456789', currentChannelId = '111111111111111111'

test('send_message works with real discord.js permissions and message serialization', () => {
    const script = `
        import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js'
        import { run } from ${JSON.stringify(join(originalDir, 'bot/send-message.ts'))}
        const client = new Client({ intents: [GatewayIntentBits.Guilds] })
        const botId = '999999999999999999', guildId = '333333333333333333', channelId = '${currentChannelId}', destinationId = '222222222222222222'
        client.user = client.users._add({ id: botId, username: 'clod', discriminator: '0', bot: true })
        const guild = client.guilds._add({ id: guildId, name: 'test', owner_id: '444444444444444444', roles: [
            { id: guildId, name: '@everyone', permissions: (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages).toString() },
        ] })
        const channel = client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: 'test', permission_overwrites: [] }, guild)
        client.channels._add({ id: destinationId, guild_id: guildId, type: ChannelType.GuildText, name: 'destination', permission_overwrites: [] }, guild)
        client.channels.fetch = async id => client.channels.cache.get(id)
        const calls = []
        client.rest.get = async route => ({ user: { id: route.split('/').at(-1), username: 'member', discriminator: '0' }, roles: [], joined_at: '2024-01-01T00:00:00Z' })
        client.rest.post = async (route, options) => { calls.push({ route, body: options.body }); return { id: '555555555555555555', channel_id: destinationId } }
        const context = { message: { author: { id: ${JSON.stringify(ownerId)}, bot: false }, content: 'please send a greeting', channelId, channel, guild } }
        console.log(JSON.stringify({ result: await run({ content: 'hello @everyone'.repeat(10), channelId: destinationId }, context, client, id => id === destinationId ? 5 : 140), calls }))
    `
    const result = spawnSync(process.execPath, ['-e', script], { cwd: originalDir, encoding: 'utf8', timeout: 10000 })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.result).toBe('message sent')
    expect(output.calls).toHaveLength(1)
    expect(output.calls[0].route).toBe('/channels/222222222222222222/messages')
    expect(output.calls[0].body.content).toBe('hello')
    expect(output.calls[0].body.allowed_mentions).toEqual({ parse: [], replied_user: false })
})

test('image upload passes validated bytes through real discord.js multipart serialization', () => {
    const script = `
        import { mock } from 'bun:test'
        import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js'
        const viewer = await import(${JSON.stringify(join(originalDir, 'bot/view-image.ts'))})
        const follow = viewer.fetchFollowingRedirects
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=', 'base64')
        mock.module(${JSON.stringify(join(originalDir, 'bot/view-image.ts'))}, () => ({
            fetchFollowingRedirects: follow,
            fetchResource: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: png }),
        }))
        const { run } = await import(${JSON.stringify(join(originalDir, 'bot/send-message.ts'))})
        const client = new Client({ intents: [GatewayIntentBits.Guilds] })
        const botId = '999999999999999999', guildId = '333333333333333333', channelId = '${currentChannelId}'
        client.user = client.users._add({ id: botId, username: 'clod', discriminator: '0', bot: true })
        const guild = client.guilds._add({ id: guildId, name: 'test', owner_id: '444444444444444444', roles: [
            { id: guildId, name: '@everyone', permissions: (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.AttachFiles).toString() },
        ] })
        const channel = client.channels._add({ id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: 'test', permission_overwrites: [] }, guild)
        client.rest.get = async route => ({ user: { id: route.split('/').at(-1), username: 'member', discriminator: '0' }, roles: [], joined_at: '2024-01-01T00:00:00Z' })
        const calls = []
        client.rest.post = async (route, options) => { calls.push({ route, body: options.body, files: options.files.map(f => ({ name: f.name, bytes: Buffer.from(f.data).toString('base64') })) }); return { id: '555555555555555555', channel_id: channelId } }
        const context = { message: { author: { id: ${JSON.stringify(otherId)}, bot: false }, channelId, channel, guild } }
        console.log(JSON.stringify({ result: await run({ content: 'image @everyone', channelId: null, imageUrl: 'https://example.com/image' }, context, client, () => 140), calls, image: png.toString('base64') }))
    `
    const result = spawnSync(process.execPath, ['-e', script], { cwd: originalDir, encoding: 'utf8', timeout: 10000 })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.result).toBe('message sent')
    expect(output.calls[0].route).toBe(`/channels/${currentChannelId}/messages`)
    expect(output.calls[0].body.allowed_mentions).toEqual({ parse: [], replied_user: false })
    expect(output.calls[0].files).toEqual([{ name: 'image.png', bytes: output.image }])
})

test('repl works with real discord.js user and member objects', () => {
    const script = `
        import { Client, GatewayIntentBits } from 'discord.js'
        import { run } from ${JSON.stringify(join(originalDir, 'bot/repl.ts'))}
        const client = new Client({ intents: [GatewayIntentBits.Guilds] })
        const user = client.users._add({ id: '123456789012345678', username: 'test', discriminator: '0', avatar: 'abc123' })
        const guild = client.guilds._add({ id: '223456789012345678', name: 'test' })
        guild.members._add({ user: { id: user.id, username: user.username, discriminator: '0', avatar: 'abc123' }, avatar: 'def456', roles: [], joined_at: '2024-01-01T00:00:00Z' })
        console.log(await run('return [(await client.users.fetch("123456789012345678")).displayAvatarURL(), (await (await client.guilds.fetch("223456789012345678")).members.fetch("123456789012345678")).displayAvatarURL()]', client))
    `
    const result = spawnSync(process.execPath, ['-e', script], { cwd: originalDir, encoding: 'utf8', timeout: 10000 })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
        'https://cdn.discordapp.com/avatars/123456789012345678/abc123.webp',
        'https://cdn.discordapp.com/guilds/223456789012345678/users/123456789012345678/avatars/def456.webp',
    ])
})
