import { ChannelType, PermissionFlagsBits, type Client, type Message } from 'discord.js'
import type { Chats } from './bot.ts'

// Sliding windows are reserved synchronously before any network call, including failures.
const windows = new Map<string, number[]>()
export const reserve = (kind: 'send' | 'lookup' | 'react', user: string, channel: string) => {
    const now = Date.now(), cutoff = now - 60_000
    for (const [key, times] of windows) {
        const recent = times.filter(time => time > cutoff)
        if (recent.length) windows.set(key, recent)
        else windows.delete(key)
    }
    const limits = kind === 'send' ? [[`send:user:${user}`, 3], [`send:channel:${channel}`, 5], ['send:global', 20]] as const
        : kind === 'react' ? [[`react:user:${user}`, 5], [`react:channel:${channel}`, 10], ['react:global', 30]] as const
            : [[`lookup:user:${user}`, 10], ['lookup:global', 50]] as const
    if (limits.some(([key, limit]) => (windows.get(key)?.length ?? 0) >= limit)) return false
    for (const [key] of limits) windows.set(key, [...(windows.get(key) ?? []), now])
    return true
}

export const targetChannel = async (message: Message, client: Client, channelId: string | null, mode: 'view' | 'send' | 'attach' | 'react' | 'history') => {
    const targetId = channelId ?? message.channelId
    if (!message.guild && targetId !== message.channelId) throw new Error('target must be the current direct message')
    const channel = targetId === message.channelId ? message.channel : await client.channels.fetch(targetId, { force: true })
    if (!channel) throw new Error('target unavailable')
    if (message.guild) {
        if (!('guildId' in channel) || channel.guildId !== message.guild.id) throw new Error('target must be in the current server')
        const members = await Promise.all([
            message.guild.members.fetch({ user: message.author.id, force: true }),
            message.guild.members.fetch({ user: client.user!.id, force: true }),
        ])
        const writes = mode === 'send' || mode === 'attach'
        const required = [PermissionFlagsBits.ViewChannel]
        if (writes) required.push(channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages)
        if (mode === 'attach') required.push(PermissionFlagsBits.AttachFiles)
        if (mode === 'react') required.push(PermissionFlagsBits.AddReactions)
        if (mode === 'history') required.push(PermissionFlagsBits.ReadMessageHistory)
        for (const member of members) {
            const permissions = channel.permissionsFor(member)
            if (!permissions?.has(required) || (writes && member.isCommunicationDisabled()))
                throw new Error('requester and bot must have the required channel permissions')
            // Bots bypass Discord slowmode, so do not send on behalf of users who cannot bypass it.
            if (writes && member.id === message.author.id && 'rateLimitPerUser' in channel && channel.rateLimitPerUser && !permissions.has(PermissionFlagsBits.BypassSlowmode))
                throw new Error('requester cannot bypass channel slowmode')
            if (channel.isThread() && channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads))
                await channel.members.fetch({ member: member.id, force: true })
        }
    } else if (!channel.isDMBased()) throw new Error('target must be the current direct message')
    return channel
}
