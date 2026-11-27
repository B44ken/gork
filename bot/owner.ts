import type { Client } from 'discord.js'
import type { Chats } from './bot.ts'

export const isOwner = (chat: Chats, client: Client) => {
    const sender = chat.message?.author ?? chat.interaction?.user
    return sender != null && sender.id === client.application!.owner?.id && !sender.bot && !chat.message?.webhookId
}
