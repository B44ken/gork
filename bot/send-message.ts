import { fileTypeFromBuffer } from 'file-type'
import type { Client } from 'discord.js'
import type { Chats } from './bot.ts'
import { reserve, targetChannel } from './discord-access.ts'
import { secrets } from './repl.ts'
import { fetchFollowingRedirects, fetchResource } from './view-image.ts'

const sent = new WeakSet<object>()
const supported = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export const run = async ({ content, channelId, imageUrl = null }: { content: string, channelId: string | null, imageUrl?: string | null }, context: Chats, client: Client, replyLimit: (channelId: string) => number): Promise<string> => {
    const message = context.message
    if (!message) return 'a message is required'
    if (sent.has(message)) return 'this request has already been handled'
    if (!content.trim() && !imageUrl) return 'message cannot be empty'
    const values = secrets(client)
    if (values.some(value => content.includes(value) || imageUrl?.includes(value))) return 'message contains a protected value'
    sent.add(message)
    if (!reserve('send', message.author.id, channelId ?? message.channelId)) return 'send rate limit reached; try again later'
    try {
        const channel = await targetChannel(message, client, channelId, imageUrl ? 'attach' : 'send')
        if (!channel.isSendable()) return 'target is not a sendable channel'
        const outgoing = content.slice(0, replyLimit(channel.id))
        let files: { attachment: Buffer, name: string }[] | undefined
        if (imageUrl) {
            const { resource } = await fetchFollowingRedirects(imageUrl, { requests: 0, bytes: 0, signal: AbortSignal.timeout(15000) }, async (url, budget) => {
                if ([...values, ...secrets(client)].some(value => url.includes(value) || decodeURIComponent(url).includes(value))) throw new Error('protected value')
                return fetchResource(url, budget)
            })
            const type = await fileTypeFromBuffer(resource.body)
            if (resource.status !== 200 || !type || !supported.has(type.mime)) return 'url did not return a supported image'
            if ([...values, ...secrets(client)].some(value => resource.body.includes(Buffer.from(value)))) return 'image contains a protected value'
            files = [{ attachment: resource.body, name: `image.${type.ext}` }]
        }
        if (secrets(client).some(value => outgoing.includes(value))) return 'message contains a protected value'
        await channel.send({ content: outgoing, ...(files && { files }), allowedMentions: { parse: [], repliedUser: false } })
        return 'message sent'
    } catch (error) {
        console.error(`send_message failed: ${error instanceof Error ? error.name : 'error'}`)
        return 'unable to send message or verify target permissions, channel slowmode, image, or scope'
    }
}
