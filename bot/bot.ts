import { AttachmentFlags, Client, DiscordAPIError, GatewayIntentBits, MessageFlags, MessageType, Routes, TextChannel, type ChatInputCommandInteraction, type Message } from 'discord.js'
import type { Config } from './config.ts'
import type { Blacklist } from './blacklist.ts'
import type { MemoryUser } from './memory.ts'
import { isOwner } from './owner.ts'
import { defaultReplyLimit } from './reply-limits.ts'
import { createReplyRateLimit } from './reply-rate-limit.ts'

type ArgType = 'string' | 'integer' | 'number' | 'user'
export const string: ArgType = 'string', integer: ArgType = 'integer', user: ArgType = 'user'
type ArgDef = ArgType | { type: ArgType, choices?: (string | number)[], optional?: boolean }
const arg = (def: ArgDef) => typeof def === 'string' ? { type: def } : def
export const oneOf = (type: ArgType, choices: (string | number)[]): ArgDef => ({ type, choices })
export const optional = (def: ArgDef): ArgDef => ({ ...arg(def), optional: true })
export type ChatLine = { id: string; name: string; msg: string; messageId?: string }
export type Chats = {
    history: ChatLine[], next: ChatLine,
    images?: { source: string; urls: string[] }[],
    generatedImages?: { attachment: Buffer; name: string }[],
    textFiles?: { source: string; name: string; text: string }[],
    reply?: { messageId: string, authorId: string, author: string, content: string },
    channel: string, message?: Message, interaction?: ChatInputCommandInteraction, restart?: boolean
}
// A ping chain is a conversation thread: every reply links to the message it answers. Its length is how
// many of the most recent messages in that thread came from bots, so bot ping-pong is capped while a
// human message ends the run and always gets an answer.
export const threadRunLimit = 6
const redirectChannelId = '859194490577092657'
const redirectMessage = 'plz use <#859205331455705128>'
export const threadRun = async (message: Message, isBot: (message: Message) => boolean, limit = threadRunLimit) => {
    let run = 0
    let current: Message | undefined = message
    while (current && run < limit && isBot(current)) {
        run++
        // A deleted or unreadable parent ends the thread instead of failing the reply.
        if (!current.reference?.messageId) break
        try { current = await current.fetchReference() } catch { break }
    }
    return run
}

type CommandResponse = { content: string, ephemeral?: boolean }
type Handler = (chat: Chats, args: Record<string, unknown>) => Promise<string | CommandResponse>
type Moderator = (text: string, chat: Chats) => Promise<string | null>

type CommandOptions = { defer?: boolean, private?: boolean }
type Command = { name: string, args: Record<string, ArgDef>, handler: Handler } & CommandOptions

export type Bot = {
    client: Client,
    name: () => string,
    command: (name: string, args: Record<string, ArgDef>, handler: Handler, options?: CommandOptions) => void,
    message: (handler: Handler) => void,
    moderate: (fn: Moderator) => void,
    ready: (token?: string) => void,
    memoryUsers: (chat: Chats, ids: string[]) => Promise<MemoryUser[]>,
}

const optionTypes: Record<ArgType, number> = { string: 3, integer: 4, user: 6, number: 10 }
const subcommandType = 1
const buildOptions = (args: Record<string, ArgDef>) =>
    Object.entries(args).map(([name, def]) => {
        const { type, choices, optional } = arg(def)
        return {
            name,
            description: 'gork',
            type: optionTypes[type],
            required: !optional,
            ...(choices ? { choices: choices.map(v => ({ name: String(v), value: v })) } : {}),
        }
    })

const getArgValue = (int: ChatInputCommandInteraction, key: string, type: ArgType) =>
    type === 'integer' ? int.options.getInteger(key) : type === 'number' ? int.options.getNumber(key) : type === 'user' ? int.options.getUser(key) : int.options.getString(key)

export const createBot = ({ config, blacklist, replyLimit = () => defaultReplyLimit }: { config: Config, blacklist: Blacklist, replyLimit?: (channelId: string) => number }): Bot => {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        allowedMentions: { parse: [], repliedUser: false },
    })
    const cmds: Command[] = []
    const canReply = createReplyRateLimit()
    let handler: Handler | undefined
    let moderator: Moderator | undefined

    const command = (name: string, args: Record<string, ArgDef>, handler: Handler, options: CommandOptions = {}) => void cmds.push({ name, args, handler, ...options })
    const message = (h: Handler) => handler = h
    const moderate = (fn: Moderator) => { moderator = fn }
    const name = () => client.user!.displayName

    const buildDiscordCommands = () => {
        const roots = new Map<string, { name: string, description: string, options: any[], default_member_permissions?: string }>()
        for (const cmd of cmds) {
            const [root, sub, nested] = cmd.name.split(' ')
            if (!sub) {
                roots.set(root, { name: root, description: 'gork', options: buildOptions(cmd.args), ...(cmd.private ? { default_member_permissions: '0' } : {}) })
                continue
            }
            if (!roots.has(root)) roots.set(root, { name: root, description: 'gork', options: [] })
            const options = roots.get(root)!.options
            if (nested) {
                let group = options.find(option => option.name == sub)
                if (!group) options.push(group = { name: sub, description: 'gork', type: 2, options: [] })
                group.options.push({ name: nested, description: 'gork', type: subcommandType, options: buildOptions(cmd.args) })
            } else {
                options.push({ name: sub, description: 'gork', type: subcommandType, options: buildOptions(cmd.args) })
            }
        }
        return [...roots.values()].map(command => {
            if (cmds.filter(cmd => cmd.name.split(' ')[0] === command.name).every(cmd => cmd.private)) command.default_member_permissions = '0'
            return command
        })
    }

    // Webhooks count as bots, since an automated sender is what a ping chain is.
    const fromBot = (message: Message) => !!message.author.bot || !!message.webhookId

    // Mentions are read defensively because partial or synthetic history messages may omit them.
    // mentions.users holds only explicit @mentions, so a bare reply to clod needs repliedUser.
    const pings = (message: Message) => !!message.mentions
        && (message.mentions.has(client.user!, { ignoreEveryone: true })
            || message.mentions.parsedUsers.has(client.user!.id)
            || message.mentions.repliedUser?.id === client.user!.id)

    const buildChats = async (msg: Message, limit = 12): Promise<Chats> => {
        const history = await msg.channel.messages.fetch({ limit, before: msg.id })
            .then(msgs => [...msgs.values()].reverse().map(m => ({ id: m.author.id, name: m.author.username, msg: m.content, ...(m.id ? { messageId: m.id } : {}) })))
        return { history, next: { id: msg.author.id, name: msg.author.username, msg: msg.content, ...(msg.id ? { messageId: msg.id } : {}) }, channel: (msg.channel as TextChannel).name, message: msg }
    }

    const memoryUsers = async (chat: Chats, ids: string[]): Promise<MemoryUser[]> => Promise.all(ids.map(async id => {
        if (chat.message?.guild) {
            try {
                const member = await chat.message.guild.members.fetch({ user: id, force: true })
                return { id, username: member.user.username, displayName: member.displayName }
            } catch (error) {
                if (!(error instanceof DiscordAPIError) || error.code !== 10007) throw error
            }
        }
        const user = await client.users.fetch(id, { force: true })
        return { id, username: user.username, displayName: user.displayName }
    }))

    const imageUrls = (msg: Message) => [...msg.attachments.values()]
        .filter(a => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.contentType?.split(';')[0].trim().toLowerCase() ?? '') && !a.flags.has(AttachmentFlags.IsAnimated))
        .map(a => a.url)

    const textExtensions = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'html', 'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rs', 'go', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'sql', 'r', 'lua', 'diff', 'patch'])

    const textAttachments = (msg: Message) => [...msg.attachments.values()].filter(a => {
        const type = a.contentType?.split(';')[0].trim().toLowerCase() ?? ''
        const extension = a.name.split('.').pop()!.toLowerCase()
        return type.startsWith('text/') || ['application/json', 'application/javascript', 'application/xml'].includes(type) || textExtensions.has(extension)
    })

    const messageAttachments = async (msg: Message) => {
        const images: NonNullable<Chats['images']> = []
        const textFiles: NonNullable<Chats['textFiles']> = []
        let reply: Chats['reply']
        const add = async (message: Message, source: string) => {
            const urls = imageUrls(message)
            if (urls.length) images.push({ source, urls })
            textFiles.push(...await Promise.all(textAttachments(message).map(async attachment => {
                const response = await fetch(attachment.url)
                if (!response.ok) throw new Error(`failed to download attachment ${attachment.name}: ${response.status}`)
                return { source, name: attachment.name, text: await response.text() }
            })))
        }
        if (msg.type === MessageType.Reply && msg.reference?.messageId) {
            try {
                const target = await msg.fetchReference()
                // The transcript names the reply target so replies like "react to this" work without a lookup.
                reply = { messageId: target.id, authorId: target.author.id, author: target.author.username, content: target.content.slice(0, 1000) }
                await add(target, `the message ${msg.author.username} replied to, by ${target.author.username}`)
            } catch (error) {
                if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error
            }
        }
        await add(msg, `the current message by ${msg.author.username}`)
        return { images, textFiles, reply }
    }

    const ready = (token?: string) => {
        client.on('ready', async () => {
            console.log('discord connected')
            // One process hosts every instance, so a gateway hiccup must not take the other bots down.
            try {
                await client.application!.fetch()
                await client.rest.put(Routes.applicationCommands(client.user!.id), { body: buildDiscordCommands() })
            } catch (error) {
                console.error(`command registration failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        })

        client.on('interactionCreate', async int => {
            if (!int.isChatInputCommand()) return
            try {
                const name = [int.commandName, int.options.getSubcommandGroup(false), int.options.getSubcommand(false)].filter(Boolean).join(' ')
                const cmd = cmds.find(c => c.name === name)
                if (!cmd) {
                    await int.reply({ content: `unknown command: ${name}`, ephemeral: true })
                    return
                }

                const args = Object.fromEntries(
                    Object.entries(cmd.args).map(([k, def]) => [k, getArgValue(int, k, arg(def).type)])
                )

                const chat: Chats = {
                    history: [],
                    next: { id: int.user.id, name: int.user.username, msg: '' },
                    channel: (int.channel as TextChannel)?.name ?? '',
                    interaction: int,
                }

                if (cmd.private && !isOwner(chat, client)) {
                    await int.reply({ content: 'only the owner can use this command', flags: MessageFlags.Ephemeral })
                    return
                }
                const status = !cmd.private && blacklist.status(int.user.id)
                if (status) {
                    await int.reply({ content: status, flags: MessageFlags.Ephemeral })
                    return
                }

                const privacy = cmd.private ? { flags: MessageFlags.Ephemeral as const } : {}
                const text = Object.values(args).filter((value): value is string => typeof value === 'string').join('\n')
                const deferred = cmd.defer || (!cmd.private && !!text && !!moderator)
                if (deferred) await int.deferReply(privacy)
                const reason = !cmd.private && text && moderator ? await moderator(text, chat) : null
                if (reason) {
                    const content = blacklist.timeout(int.user.id, reason)
                    if (deferred) await int.editReply({ content })
                    else await int.reply({ content, flags: MessageFlags.Ephemeral })
                    return
                }
                const result = await cmd.handler(chat, args)
                const out = typeof result === 'string' ? result : result.content
                const responsePrivacy = typeof result === 'string' ? privacy : result.ephemeral ? { flags: MessageFlags.Ephemeral as const } : privacy
                if (deferred) await int.editReply({ content: out.slice(0, 1990) || 'done' })
                else await int.reply({ content: out || 'done', ...responsePrivacy })
                if (chat.restart) process.exit(0)
            } catch (error) {
                // A failing turn must not take down every instance hosted by this process.
                console.error(`command ${int.commandName} failed: ${error instanceof Error ? error.message : String(error)}`)
                const content = `that command failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1500)
                try {
                    if (int.deferred || int.replied) await int.editReply({ content })
                    else await int.reply({ content, flags: MessageFlags.Ephemeral })
                } catch {}
            }
        })

        client.on('messageCreate', async msg => {
            if (msg.author.id === client.user!.id) return
            try {
                const chat = await buildChats(msg, config.context)

                const mentioned = pings(msg)
                const prevI = chat.history.toReversed().findIndex(h => h.id == client.user!.id)

                const lobotomy = chat.history.findLastIndex(h => h.msg.includes('the operation was a success'))
                chat.history = chat.history.slice(lobotomy + 1)

                const redirectedMention = mentioned && msg.channelId === redirectChannelId
                const shouldReply = redirectedMention || mentioned || (msg.channelId !== redirectChannelId && (prevI === -1 || prevI > config.waffle.after_msgs) && Math.random() < config.waffle.chance)

                if (!handler || !shouldReply) return
                if (!canReply(msg.author.id, config.reply_rate_limit.messages, config.reply_rate_limit.window_seconds)) return
                if (redirectedMention) {
                    await msg.reply(redirectMessage)
                    return
                }
                const status = blacklist.status(msg.author.id)
                if (status) {
                    await msg.reply(status)
                    return
                }
                const reason = moderator && await moderator(msg.content, chat)
                if (reason) {
                    await msg.reply(blacklist.timeout(msg.author.id, reason))
                    return
                }
                if (fromBot(msg)) {
                    const run = await threadRun(msg, fromBot)
                    if (run >= threadRunLimit) {
                        console.log(`bot ping chain is ${run} deep; staying quiet in ${chat.channel}`)
                        return
                    }
                }
                Object.assign(chat, await messageAttachments(msg))
                void Promise.resolve().then(() => msg.channel.sendTyping()).catch(() => {})
                const result = await handler(chat, {})
                const content = (typeof result === 'string' ? result : result.content).slice(0, replyLimit(msg.channelId))
                await msg.reply(chat.generatedImages?.length ? { content, files: chat.generatedImages } : content)
                if (chat.restart) process.exit(0)
            } catch (error) {
                // An unhandled rejection here used to exit the process and restart every instance.
                console.error(`reply failed: ${error instanceof Error ? error.message : String(error)}`)
                const content = `my brain broke: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1500)
                try {
                    await msg.reply(content)
                } catch {}
            }
        })

        if (!token) throw new Error('DISCORD_TOKEN is not set')
        console.log('connecting to discord')
        client.login(token)
    }

    return { client, name, command, message, moderate, ready, memoryUsers }
}
