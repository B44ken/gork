// discord.js drops DMs in channels it hasn't cached: the gateway's MESSAGE_CREATE says channel_type=1,
// but discord.js never reads that field, so it can't build the DM channel and silently discards the message.
// 'raw' fires just before discord.js handles the packet; by the time the fetch below resolves, that attempt
// has already been dropped, so replaying it emits messageCreate exactly once. Later DMs in the channel are
// handled by discord.js itself, because the channel is cached from then on.
export default async (packet: any, instance: any) => {
    if (packet?.t !== 'MESSAGE_CREATE' || packet.d.guild_id) return
    const client = instance.client
    if (client.channels.cache.has(packet.d.channel_id)) return
    await client.channels.fetch(packet.d.channel_id)
    client.actions.MessageCreate.handle(packet.d)
}
