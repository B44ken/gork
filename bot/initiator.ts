import type { Chats } from './bot.ts'

export type Initiator = {
    type: 'discord_message', message_id: string, channel_id: string,
    guild_id: string | null, user_id: string,
}

export const messageInitiator = (context: Chats): Initiator | null => {
    const message = context.message
    return message ? {
        type: 'discord_message', message_id: message.id, channel_id: message.channelId,
        guild_id: message.guildId ?? null, user_id: message.author.id,
    } : null
}
