import 'dotenv/config'
import { Client, GatewayIntentBits, REST, Routes, TextChannel, type ChatInputCommandInteraction, type Message } from 'discord.js'

type ArgType = 'string' | 'integer' | 'user'
export const string: ArgType = 'string', integer: ArgType = 'integer', user: ArgType = 'user'
type ArgDef = ArgType | { type: ArgType, choices?: (string | number)[] }
const arg = (def: ArgDef) => typeof def === 'string' ? { type: def } : def
export const oneOf = (type: ArgType, choices: (string | number)[]): ArgDef => ({ type, choices })
type Chats = {
    history: { id: string; name: string; msg: string }[], next: { id: string; name: string; msg: string },
    channel: string, message?: Message, interaction?: ChatInputCommandInteraction
}
type Handler = (chat: Chats, args: Record<string, unknown>) => void | Promise<string | undefined>

type Command = { name: string, args: Record<string, ArgDef>, handler: Handler }
const cmds: Command[] = []
export const command = (name: string, args: Record<string, ArgDef>, handler: Handler) => void cmds.push({ name, args, handler })

let msgHandler: Handler | undefined
export const message = (h: Handler) => msgHandler = h
let historyDepthGetter = () => 12
export const setHistoryDepthGetter = (getter: () => number) => { historyDepthGetter = getter }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })

const getArgValue = (int: ChatInputCommandInteraction, key: string, type: ArgType) =>
    type === 'integer' ? int.options.getInteger(key) : type === 'user' ? int.options.getUser(key) : int.options.getString(key)

const optionTypes: Record<ArgType, number> = { string: 3, integer: 4, user: 6 }
const subcommandType = 1
const buildOptions = (args: Record<string, ArgDef>) =>
    Object.entries(args).map(([name, def]) => {
        const { type, choices } = arg(def)
        return {
            name,
            description: 'gork',
            type: optionTypes[type],
            required: true,
            ...(choices ? { choices: choices.map(v => ({ name: String(v), value: v })) } : {}),
        }
    })

const buildDiscordCommands = () => {
    const roots = new Map<string, { name: string, description: string, options: any[] }>()
    for (const cmd of cmds) {
        const [root, sub] = cmd.name.split(' ')
        if (!sub) {
            roots.set(root, { name: root, description: 'gork', options: buildOptions(cmd.args) })
            continue
        }
        if (!roots.has(root)) roots.set(root, { name: root, description: 'gork', options: [] })
        roots.get(root)!.options.push({ name: sub, description: 'gork', type: subcommandType, options: buildOptions(cmd.args) })
    }
    return [...roots.values()]
}

const buildChats = async (msg: Message, n = 12): Promise<Chats> => {
    const history = await msg.channel.messages.fetch({ limit: 20 })
        .then((msgs: Map<any, Message>) => [...msgs.values()].reverse().slice(-n).map(m => ({ id: m.author.id, name: m.author.username, msg: m.content })))
    history.pop()
    return { history, next: { id: msg.author.id, name: msg.author.username, msg: msg.content }, channel: (msg.channel as TextChannel).name, message: msg }
}

export const ready = () => {
    client.on('ready', async () =>
        new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!)
            .put(Routes.applicationCommands(client.user!.id), { body: buildDiscordCommands() }))

    client.on('interactionCreate', async int => {
        if (!int.isChatInputCommand()) return

        let sub: string | undefined
        try { sub = int.options.getSubcommand() } catch {}

        const name = sub ? `${int.commandName} ${sub}` : int.commandName
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

        const out = await cmd.handler(chat, args)
        await int.reply({ content: out || 'done' })
    })

    client.on('messageCreate', async msg => {
        if (msg.author.id === client.user!.id) return
        const mentioned = msg.mentions.members?.has(client.user!.id)
        const isBot = msg.author.bot

        if (!mentioned && !isBot) return

        if (!mentioned && isBot) {
            const C = historyDepthGetter()
            const history = await msg.channel.messages.fetch({ limit: C + 1 })
            const N = [...history.values()].filter(m => m.author.bot && m.author.id !== client.user!.id).length
            const chance = 1 - Math.pow(N - 1, 2) / C
            if (Math.random() >= chance) return
        }

        msg.channel.sendTyping()
        const chat = await buildChats(msg, historyDepthGetter())
        if (msgHandler) {
            const reply = await msgHandler(chat, {})
            if (reply && reply.trim()) await msg.reply(reply)
        }
    })

    const token = process.env.DISCORD_TOKEN
    if (!token) throw new Error('DISCORD_TOKEN is not set')
    client.login(token)
}

