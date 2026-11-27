// Decides which Discord messages wake the agent and how they are described to it. Messages that do not
// mention the bot are only counted; the agent reads /chat when it wants the context.
import type { Message } from 'discord.js'
import type { kernel as Kernel } from '../kernel.ts'

// Bot ping-pong stops after this many consecutive bot messages in a reply chain; a human message resets it.
export const botChainLimit = 6
// ponytail: in-memory per-user limit, reset on restart; persist it if people start abusing restarts.
const perUserPerMinute = 5
const seen = new Map<string, number[]>()

const fromBot = (message: Message) => message.author.bot || !!message.webhookId

export const botChain = async (message: Message) => {
    let run = 0
    let current: Message | undefined = message
    while (current && run < botChainLimit && fromBot(current)) {
        run++
        if (!current.reference?.messageId) break
        try { current = await current.fetchReference() } catch { break }
    }
    return run
}

const allowed = (userId: string) => {
    const now = Date.now()
    const recent = (seen.get(userId) ?? []).filter(time => time > now - 60_000)
    seen.set(userId, [...recent, now])
    return recent.length < perUserPerMinute
}

export default async (message: Message, instance: any, kernel: typeof Kernel) => {
    const me = message.client.user
    if (message.author.id === me.id) return
    const addressed = message.channel.isDMBased()
        || message.mentions.users.has(me.id)
        || message.mentions.repliedUser?.id === me.id
    instance.unseen ??= {}
    if (!addressed) {
        instance.unseen[message.channelId] = (instance.unseen[message.channelId] ?? 0) + 1
        return
    }
    if (fromBot(message) && await botChain(message) >= botChainLimit) return
    if (!allowed(message.author.id)) return

    const where = message.inGuild() ? `#${message.channel.name} (channel ${message.channelId}) in ${message.guild.name}` : `a DM (channel ${message.channelId})`
    const unseen = instance.unseen[message.channelId] ?? 0
    delete instance.unseen[message.channelId]
    const author = message.member?.displayName ?? message.author.username
    const files = [...message.attachments.values()].map(a => `/chat/attachment/${message.channelId}/${message.id}/${a.name}`)
    const event = [
        `[event] message ${message.id} in ${where} from ${author} (${message.author.id}${fromBot(message) ? ', bot' : ''})${message.reference?.messageId ? `, replying to ${message.reference.messageId}` : ''}:`,
        message.content,
        files.length ? `attachments: ${files.join(' ')}` : '',
        unseen ? `(${unseen} other messages arrived in this channel since you were last addressed there)` : '',
    ].filter(Boolean).join('\n')

    // ponytail: the shell env reflects the latest event, so a turn batching several events sees the newest one.
    instance.current = { CHANNEL: message.channelId, MESSAGE: message.id, AUTHOR: message.author.id, ...(message.guildId && { GUILD: message.guildId }) }
    if (message.channel.isSendable()) message.channel.sendTyping().catch(() => {})
    instance.thread.push(event)
}
