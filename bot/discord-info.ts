import type { Client } from 'discord.js'
import type { Chats } from './bot.ts'
import { reserve, targetChannel } from './discord-access.ts'

export const run = async ({ operation, id }: { operation: 'channel' | 'member-avatar', id: string | null }, context: Chats, client: Client) => {
    const message = context.message
    if (!message) return 'a message is required'
    if (!['channel', 'member-avatar'].includes(operation)) return 'unsupported operation'
    if (!reserve('lookup', message.author.id, message.channelId)) return 'lookup rate limit reached; try again later'
    try {
        const channel = await targetChannel(message, client, operation === 'channel' ? id : null, 'view')
        if (operation === 'channel') return { id: channel.id, name: 'name' in channel ? channel.name : null, type: channel.type }
        const userId = id ?? message.author.id
        if (message.guild) {
            const member = await message.guild.members.fetch({ user: userId, force: true })
            return { id: member.id, displayName: member.displayName, avatarUrl: member.displayAvatarURL() }
        }
        if (userId !== message.author.id) return 'only the current direct message participant can be looked up'
        return { id: message.author.id, displayName: message.author.displayName, avatarUrl: message.author.displayAvatarURL() }
    } catch (error) {
        console.error(`discord-info failed: ${error instanceof Error ? error.name : 'error'}`)
        return 'unable to verify access or find the requested Discord resource'
    }
}
