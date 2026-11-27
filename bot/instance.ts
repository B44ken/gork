import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Exa from 'exa-js'
import type { User } from 'discord.js'
import { createBot, oneOf, optional, string as stringArg, type Bot } from './bot.ts'
import { createAI, type AI } from './ai.ts'
import { createState } from './state.ts'
import { createConfig, type ConfigStore } from './config.ts'
import { createMemory } from './memory.ts'
import { createPersona } from './persona.ts'
import { createBlacklist } from './blacklist.ts'
import { createUsage } from './usage.ts'
import { createModeration } from './moderation.ts'
import { createAgent, type Agent } from './agent.ts'
import { createSource } from './source.ts'
import { createMonkeypatch, isOwner as isMonkeypatchOwner } from './monkeypatch.ts'
import { createImageGeneration } from './image-generation.ts'
import { viewImage } from './view-image.ts'
import { messageInitiator } from './initiator.ts'
import { isOwner } from './owner.ts'
import { createReplyLimits } from './reply-limits.ts'
import * as sendMessage from './send-message.ts'
import * as discordInfo from './discord-info.ts'
import * as messages from './messages.ts'
import * as repl from './repl.ts'
import type { DashboardContext } from '../site/state.ts'

// One process may host several instances, so every mutable file lives in the instance directory and code is read from this checkout.
export const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

export type InstanceOptions = {
    name: string
    directory: string
    envFile?: string
    token?: string
    exaApiKey?: string
    allowProcessEnv?: boolean
}

export type Instance = {
    name: string
    directory: string
    bot: Bot
    ai: AI
    agent: Agent
    config: ConfigStore
    dashboard: { context: DashboardContext, users: Bot['client']['users'] }
    start: (token?: string) => void
    stop: () => Promise<void>
}

const parseEnv = (file: string) => {
    const env: Record<string, string> = {}
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const index = trimmed.indexOf('=')
        if (index < 1) continue
        const key = trimmed.slice(0, index).trim().replace(/^export\s+/, '')
        let value = trimmed.slice(index + 1).trim()
        const quote = value[0]
        if (value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote) value = value.slice(1, -1)
        env[key] = value
    }
    return env
}

export const createInstance = (options: InstanceOptions): Instance => {
    const name = options.name
    const directory = resolve(options.directory)
    const envFile = resolve(directory, options.envFile ?? '.env.local')
    const env = existsSync(envFile) ? parseEnv(envFile) : {}
    // Codex API mode reads its key from the process environment; instances share this one process.
    if (env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
    const token = options.token ?? env.DISCORD_TOKEN ?? (options.allowProcessEnv === false ? undefined : process.env.DISCORD_TOKEN)
    const exaApiKey = options.exaApiKey ?? env.EXA_API_KEY ?? process.env.EXA_API_KEY

    const store = createState(directory)
    const configStore = createConfig(store)
    const config = configStore.config
    const memory = createMemory(store)
    const persona = createPersona(directory)
    const replyLimits = createReplyLimits(directory)
    const blacklist = createBlacklist(directory, config)
    const usage = createUsage(directory)
    const bot = createBot({ config, blacklist, replyLimit: replyLimits.forChannel })
    const ai = createAI({ config, track: usage.trackCodexTurn })
    const moderation = createModeration({ config, track: usage.trackCodexTurn })
    const source = createSource(root)
    const agent = createAgent({ source, track: usage.trackCodexTurn, config })
    const monkeypatch = createMonkeypatch({ root, track: usage.trackCodexTurn, config })
    const images = createImageGeneration({ config, track: usage.trackCodexTurn, trackImage: usage.trackImage, apiKey: env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY })
    const exa = new Exa(exaApiKey)

    bot.moderate(moderation.banned)

    ai.tool('web-search', 'search a question via exa', ['query'], async ({ query }, context) => (await usage.trackExaSearch(() => exa.search(query, { numResults: 5, contents: { highlights: { maxCharacters: 1000 } } }), messageInitiator(context)))?.results.map(({ title, url, highlights }) => ({ title, url, highlights })))
    ai.tool('view-image', 'visually inspect an image at a public http or https url', ['url'], ({ url }) => viewImage(url))
    ai.tool('generate-image', 'create an image or edit the images attached to the current message or the message it replies to; the result is attached to the reply', {
        prompt: { type: 'string', description: 'description of the desired image or edits' },
        action: { type: 'string', enum: ['generate', 'edit'], description: 'edit uses the attached images; generate creates an image from scratch' },
        size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'], description: 'image size; use auto unless specified' },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: 'image quality; use auto unless specified' },
    }, images.run)
    const userId = { type: 'string', description: 'discord user id from the conversation or memory labels, never a username' }
    const mayManageMemories = (chat: Parameters<typeof isOwner>[0], targetId: string) =>
        isOwner(chat, bot.client) || (targetId === chat.next.id && targetId !== bot.client.user!.id)
    const memoryRefusal = 'only the owner can change another user’s memories or the bot’s memories'
    ai.tool('add-fun-fact', 'adds to memory', { userId, fact: { type: 'string' } }, memory.addFact)
    ai.tool('delete-fun-fact', 'deletes a memory fact; members may delete their own, and only the owner may delete another user’s or the bot’s', { userId, fact: { type: 'string' } }, ({ userId, fact }, chat) =>
        mayManageMemories(chat, userId) ? memory.deleteFact({ userId, fact }) : memoryRefusal,
        chat => isOwner(chat, bot.client) || chat.next.id !== bot.client.user!.id)
    ai.tool('view-memories', 'lists numbered memories for a user', { userId }, ({ userId }) => memory.listFacts(userId))
    ai.tool('delete-memory', 'deletes a numbered memory for a user; members may delete their own, and only the owner may delete another user’s or the bot’s', { userId, number: { type: 'integer' } }, ({ userId, number }, chat) =>
        mayManageMemories(chat, userId) ? memory.deleteFactAt(userId, number) : memoryRefusal,
        chat => isOwner(chat, bot.client) || (chat.next.id !== bot.client.user!.id))
    ai.tool('nuke-user-memories', 'deletes every memory for a user; members may nuke their own, and only the owner may nuke another user’s or the bot’s', { userId }, ({ userId }, chat) =>
        mayManageMemories(chat, userId) ? memory.nukeFacts(userId) : memoryRefusal,
        chat => isOwner(chat, bot.client) || (chat.next.id !== bot.client.user!.id))
    ai.tool('nuke-all-memories', 'deletes all memories for all users; owner-only', [], (_, chat) =>
        isOwner(chat, bot.client) ? memory.nukeFacts() : memoryRefusal,
        chat => isOwner(chat, bot.client))
    ai.tool('list-source', 'list clod’s source files', [], () => source.list())
    ai.tool('read-source', 'read a source file by its path from list-source', ['path'], ({ path }) => source.read(path))
    ai.tool('coding-agent', 'spawn a read-only coding agent to investigate clod’s code; available to everyone', ['task'], ({ task }, context) => agent.run(task, messageInitiator(context)))
    ai.tool('monkeypatch', 'owner-only: use a coding agent to edit and test clod’s code when the owner asks in ordinary language; no command or prefix is required', {
        task: { type: 'string' },
        effort: { type: ['string', 'null'], enum: ['medium', 'high', null], description: 'reasoning effort; null defaults to high' },
    }, ({ task, effort }, context) => monkeypatch.run(task, context, effort ?? undefined), monkeypatch.isOwner)
    ai.tool('inspect-usage', 'read-only aggregated usage, tokens, and estimated or reported costs from usage.sqlite; all groupings including initiator are available to everyone', {
        start_date: { type: ['string', 'null'], description: 'inclusive UTC start date YYYY-MM-DD or timestamp YYYY-MM-DDTHH:mm:ss.sssZ; null for no lower bound or when using last_minutes' },
        end_date: { type: ['string', 'null'], description: 'exclusive UTC end date YYYY-MM-DD or timestamp YYYY-MM-DDTHH:mm:ss.sssZ; null for no upper bound or when using last_minutes' },
        last_minutes: { type: ['integer', 'null'], description: 'positive rolling window in minutes ending now; set both dates to null, or null to use date/timestamp bounds' },
        group_by: { type: 'string', enum: ['total', 'day', 'source', 'model', 'requested_model', 'provider', 'initiator'] },
    }, args => usage.inspectUsage(args))
    ai.tool('discord-repl', 'owner-only: run JavaScript against the live discord.js client. code is an async function body; use return to provide a result', ['code'], ({ code }) => repl.run(code, bot.client), chat => isMonkeypatchOwner(chat) && isOwner(chat, bot.client))
    ai.tool('send_message', 'send a message or image to a permitted channel in the current server, or the current direct message; mentions do not notify; rate limited', {
        content: { type: 'string', description: 'message to send; may be empty when sending an image' },
        channelId: { type: ['string', 'null'], description: 'destination channel id, or null for the current channel' },
        imageUrl: { type: ['string', 'null'], description: 'public HTTP(S) image URL to upload, or null; local files are not supported' },
    }, (args, context) => sendMessage.run(args, context, bot.client, replyLimits.forChannel))
    ai.tool('discord-info', 'look up a permitted channel or a member avatar in the current server, or the current direct message and its sender; rate limited', {
        operation: { type: 'string', enum: ['channel', 'member-avatar'] },
        id: { type: ['string', 'null'], description: 'channel or member ID, or null for the current channel or sender' },
    }, (args, context) => discordInfo.run(args, context, bot.client))
    ai.tool('find-messages', 'search recent messages in the current channel or another permitted channel in this server, or look up one message id; rate limited', {
        query: { type: ['string', 'null'], description: 'case-insensitive text to find in message content; null to skip' },
        author: { type: ['string', 'null'], description: 'username, display name or user id to filter by; null to skip' },
        message_id: { type: ['string', 'null'], description: 'return exactly this message id instead of searching; null to search' },
        channel_id: { type: ['string', 'null'], description: 'channel id to read, or null for the current channel' },
        limit: { type: 'integer', description: 'maximum results, 1 to 25' },
    }, (args, context) => messages.find(args, context, bot.client))
    ai.tool('react', 'add one emoji reaction to a message: the message being replied to by default, the current message if there is no reply, or a message id; rate limited', {
        emoji: { type: 'string', description: 'one emoji such as 👍, or a custom emoji as name:id' },
        message_id: { type: ['string', 'null'], description: 'message id to react to, or null for the replied-to or current message' },
        channel_id: { type: ['string', 'null'], description: 'channel holding that message, or null for the current channel' },
    }, (args, context) => messages.react(args, context, bot.client))
    ai.tool('view-persona', 'view clod’s configurable persona prompt', [], () => persona.view(bot.name()))
    ai.tool('set-persona', 'replace clod’s configurable persona prompt', ['content'], ({ content }) => persona.set(content))
    ai.tool('reset-persona', 'reset clod’s configurable persona prompt to its default', [], () => persona.reset())
    ai.tool('view-channel-reply-limit', 'owner-only: view the default and channel reply limits, or one channel limit', {
        channelId: { type: ['string', 'null'], description: 'channel ID, or null to list the default and all overrides' },
    }, ({ channelId }) => replyLimits.view(channelId ?? undefined), chat => isOwner(chat, bot.client))
    ai.tool('set-channel-reply-limit', 'owner-only: set a channel reply limit from 1 to 1990 characters', {
        channelId: { type: 'string', description: 'Discord channel ID' },
        limit: { type: 'integer', description: 'maximum reply length in characters' },
    }, ({ channelId, limit }) => replyLimits.set(channelId, limit), chat => isOwner(chat, bot.client))
    ai.tool('reset-channel-reply-limit', 'owner-only: remove a channel reply limit override', ['channelId'], ({ channelId }) => replyLimits.reset(channelId), chat => isOwner(chat, bot.client))

    bot.command('lobotomize', {}, async () => 'the operation was a success:)')
    bot.command('monkeypatch', { task: stringArg, effort: optional(oneOf(stringArg, ['medium', 'high'])) },
        async (chat, { task, effort }) => monkeypatch.run(String(task), chat, (effort ?? undefined) as any), { defer: true, private: true })
    bot.command('agent', { task: stringArg }, async (_, { task }) => agent.run(String(task)), { defer: true })
    bot.command('blacklist add', { user: 'user' }, async (_, { user }) => blacklist.add((user as User).id), { private: true })
    bot.command('blacklist remove', { user: 'user' }, async (_, { user }) => blacklist.remove((user as User).id), { private: true })
    bot.command('blacklist list', {}, async () => blacklist.list(), { private: true })
    bot.command('persona view', {}, async () => persona.view(bot.name()))
    bot.command('persona set', { prompt: stringArg }, async (_, { prompt }) => persona.set(String(prompt)), { private: true })
    bot.command('persona reset', {}, async () => persona.reset(), { private: true })
    bot.command('gork channel-limit view', { channel_id: optional(stringArg) }, async (_, { channel_id }) => replyLimits.view(channel_id ? String(channel_id) : undefined), { private: true })
    bot.command('gork channel-limit set', { channel_id: stringArg, limit: 'integer' }, async (_, { channel_id, limit }) => replyLimits.set(String(channel_id), Number(limit)), { private: true })
    bot.command('gork channel-limit reset', { channel_id: stringArg }, async (_, { channel_id }) => replyLimits.reset(String(channel_id)), { private: true })
    for (const { command, key, type, choices } of configStore.settings) {
        const option = choices ? oneOf(type, choices) : type
        bot.command(`gork config ${command}`, { value: option }, async (_, { value }) => configStore.setConfig({ key, value: String(value) }), { private: true })
    }

    bot.command('memories view', { user: 'user' }, async (_, { user }) => memory.listFacts((user as User).id))
    bot.command('memories add', { user: 'user', fact: stringArg }, async (_, { user, fact }) => {
        const id = (user as User).id
        memory.addFact({ userId: id, fact: String(fact) })
        return `added memory for ${id}`
    })
    bot.command('memories delete', { user: 'user', number: 'integer' }, async (chat, { user, number }) => {
        const id = (user as User).id
        return mayManageMemories(chat, id) ? memory.deleteFactAt(id, Number(number)) : { content: memoryRefusal, ephemeral: true }
    })
    bot.command('memories nuke user', { user: 'user' }, async (chat, { user }) => {
        const id = (user as User).id
        return mayManageMemories(chat, id) ? memory.nukeFacts(id) : { content: memoryRefusal, ephemeral: true }
    })
    bot.command('memories nuke all', {}, async chat =>
        isOwner(chat, bot.client) ? memory.nukeFacts() : { content: 'only the owner can nuke all memories', ephemeral: true })

    bot.message(async chat => {
        const { history, next } = chat
        const facts = persona.view(bot.name()).includes('{facts}')
            ? memory.buildFacts(await bot.memoryUsers(chat, [...new Set([bot.client.user!.id, ...history.map(h => h.id), next.id])].filter(id => memory.load().facts[id]?.length)))
            : ''
        return ai.get(chat, persona.render(bot.name(), { limit: replyLimits.forChannel(chat.message?.channelId ?? chat.interaction?.channelId ?? ''), facts }), history, next)
    })

    const context: DashboardContext = {
        name: () => bot.name(), memory, persona, blacklist, config: configStore,
        usage: options => usage.inspectUsage(options),
    }
    return {
        name, directory, bot, ai, agent, config: configStore,
        dashboard: { context, users: bot.client.users },
        start(tokenOverride?: string) {
            bot.ready(tokenOverride ?? token)
        },
        async stop() {
            await bot.client.destroy?.()
        },
    }
}
