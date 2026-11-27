import type { Client, Message } from 'discord.js'
import type { Chats } from './bot.ts'
import { reserve, targetChannel } from './discord-access.ts'

const maxScan = 200
const maxResults = 25

export type Candidate = {
    id: string
    content: string
    createdTimestamp: number
    author: { id: string, username: string, displayName?: string | null }
}

// discord.js narrows channel unions one type at a time, so reads go through this shape instead.
type MessageChannel = { name?: string, messages?: { fetch: { (options: { limit: number }): Promise<Map<string, Message>>, (id: string, options: { force: boolean }): Promise<Message> } } }
const messageChannel = (channel: unknown) => channel as MessageChannel
const channelName = (channel: MessageChannel) => typeof channel.name === 'string' ? channel.name : 'direct messages'

export const excerpt = (text: string, length = 280) => {
    const single = text.replace(/\s+/g, ' ').trim()
    return single.length > length ? `${single.slice(0, length)}…` : single
}

// One unicode grapheme (including skin tones and joiners) or a custom emoji as name:id or <:name:id>.
export const normalizeEmoji = (value: string): string | null => {
    const emoji = value.trim()
    if (!emoji || emoji.length > 100 || /\s/.test(emoji)) return null
    if (/^(?:<a?:)?[\w~]+:\d+>?$/.test(emoji)) return emoji
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emoji)].length === 1 ? emoji : null
}

export const matchRecent = (messages: Candidate[], { query = null, author = null, limit = 10 }: { query?: string | null, author?: string | null, limit?: number } = {}) => {
    const text = query?.trim().toLowerCase() ?? ''
    const who = author?.trim().toLowerCase() ?? ''
    const count = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), maxResults)
    return messages
        .filter(message => (!text || message.content.toLowerCase().includes(text))
            && (!who || [message.author.username, message.author.displayName ?? '', message.author.id].some(name => name.toLowerCase().includes(who))))
        .toSorted((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, count)
}

const describe = (message: Message) => ({
    id: message.id,
    author: message.member?.displayName ?? message.author.username,
    author_id: message.author.id,
    sent: new Date(message.createdTimestamp).toISOString(),
    content: excerpt(message.content),
    attachments: [...message.attachments.values()].map(attachment => attachment.name),
    url: message.url,
})

const failure = (name: string, error: unknown) => {
    console.error(`${name} failed: ${error instanceof Error ? error.name : 'error'}`)
    return 'unable to reach that message or verify channel access'
}

export const find = async ({ query = null, author = null, message_id = null, channel_id = null, limit = 10 }: {
    query?: string | null, author?: string | null, message_id?: string | null, channel_id?: string | null, limit?: number,
}, context: Chats, client: Client): Promise<unknown> => {
    const message = context.message
    if (!message) return 'a message is required'
    if (!reserve('lookup', message.author.id, channel_id ?? message.channelId)) return 'lookup rate limit reached; try again later'
    try {
        const channel = messageChannel(await targetChannel(message, client, channel_id, 'history'))
        if (!channel.messages) return 'target channel has no message history'
        if (message_id) {
            try {
                return describe(await channel.messages.fetch(message_id, { force: true }))
            } catch {
                return 'no message with that id is visible in that channel'
            }
        }
        const scanned = [...(await channel.messages.fetch({ limit: maxScan })).values()]
        const matches = matchRecent(scanned, { query, author, limit })
        if (!matches.length) return `no messages matched in the last ${scanned.length} messages of ${channelName(channel)}`
        return { channel: channelName(channel), scanned: scanned.length, matches: matches.map(describe) }
    } catch (error) {
        return failure('find-messages', error)
    }
}

export const react = async ({ emoji, message_id = null, channel_id = null }: {
    emoji: string, message_id?: string | null, channel_id?: string | null,
}, context: Chats, client: Client): Promise<unknown> => {
    const message = context.message
    if (!message) return 'a message is required'
    const value = normalizeEmoji(emoji)
    if (!value) return 'unsupported emoji: use one emoji such as 👍, or a custom emoji as name:id'
    if (!reserve('react', message.author.id, channel_id ?? message.channelId)) return 'reaction rate limit reached; try again later'
    try {
        const channel = messageChannel(await targetChannel(message, client, channel_id, 'react'))
        if (!channel.messages) return 'target channel has no messages'
        const id = message_id ?? context.reply?.messageId ?? null
        const target = id ? await channel.messages.fetch(id, { force: true }) : message
        await target.react(value)
        return { reacted: value, message_id: target.id, author: target.author.username, content: excerpt(target.content, 120) }
    } catch (error) {
        return failure('react', error)
    }
}
