import type { UserManager } from 'discord.js'
import type { Memory } from '../bot/memory.ts'
import type { Persona } from '../bot/persona.ts'
import type { Blacklist } from '../bot/blacklist.ts'
import type { ConfigStore } from '../bot/config.ts'
import type { InspectOptions } from '../bot/usage.ts'

export type DashboardContext = {
    name: () => string,
    memory: Memory,
    persona: Persona,
    blacklist: Blacklist,
    config: ConfigStore,
    usage: (options: InspectOptions) => Promise<unknown>,
}

export const dashboardState = async (context: DashboardContext, users: UserManager) => {
    const facts = context.memory.load().facts, timeouts = context.blacklist.activeTimeouts(), blockedIds = context.blacklist.userIds()
    const ids = new Set([...Object.keys(facts), ...blockedIds, ...timeouts.map(entry => entry.userId), ...users.cache.keys()])
    const people = await Promise.all([...ids].map(async id => ({ id, username: (await users.fetch(id)).username })))
    people.sort((a, b) => a.username.localeCompare(b.username))
    const names = new Map(people.map(user => [user.id, user.username]))
    return {
        name: context.name(),
        config: context.config.config, settings: context.config.settings.map(setting => ({ ...setting, value: context.config.value(setting.key) })),
        facts, users: people, persona: context.persona.view(context.name()), personaMaxLength: context.persona.maxLength,
        blacklist: blockedIds.map(id => ({ id, username: names.get(id) })),
        timeouts: timeouts.map(entry => ({ ...entry, username: names.get(entry.userId) })),
    }
}

export const dashboardUsage = async (context: DashboardContext, options: InspectOptions, users: UserManager) => {
    const usage = await context.usage(options) as any
    if (typeof usage !== 'string' && options.group_by === 'initiator') {
        await Promise.all(usage.rows.map(async row => {
            const initiator = row.usage_group
            if (initiator) row.usage_group = {
                username: (await users.fetch(initiator.user_id)).username,
                message: `https://discord.com/channels/${initiator.guild_id ?? '@me'}/${initiator.channel_id}/${initiator.message_id}`,
            }
        }))
    }
    return usage
}
