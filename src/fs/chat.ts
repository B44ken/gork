// /chat: a read-only virtual filesystem over Discord. Nothing is mirrored; every read is an API call.
//   /chat/channels.md                          channels the bot can see
//   /chat/channel/<id>.md                      the last 100 messages (tail/head -n N fetch exactly N)
//   /chat/attachment/<channel>/<message>/      that message's attachments, downloaded on read
import type { Client, Message } from 'discord.js'

export type ChatMessage = {
    id: string, content: string, at: number, author: { id: string, name: string, bot: boolean },
    replyTo?: string, attachments: { name: string, url: string }[],
}
export type Source = {
    channels: () => Promise<{ id: string, name: string, where: string }[]>
    // Discord order is not relied on; results are sorted by id here.
    messages: (channelId: string, page: { limit: number, before?: string, after?: string }) => Promise<ChatMessage[]>
    message: (channelId: string, messageId: string) => Promise<ChatMessage>
    download: (url: string) => Promise<Uint8Array>
}

export const recent = 100
export const maxFetch = 5000
const byId = (a: ChatMessage, b: ChatMessage) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)

const line = (channelId: string, m: ChatMessage) => {
    const time = new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')
    const files = m.attachments.map(a => ` [file: /chat/attachment/${channelId}/${m.id}/${a.name}]`).join('')
    return `[${m.id}] ${m.author.name} (${m.author.id}${m.author.bot ? ', bot' : ''}) ${time}${m.replyTo ? ` ↩${m.replyTo}` : ''}: ${m.content.replaceAll('\n', '\n    ')}${files}`
}

// Pages through history from one end, 100 at a time, fetching only what is asked for.
export const fetchEnd = async (source: Source, channelId: string, count: number, end: 'last' | 'first') => {
    const out: ChatMessage[] = []
    let cursor = end === 'first' ? '0' : undefined
    while (out.length < Math.min(count, maxFetch)) {
        const limit = Math.min(100, count - out.length)
        const page = (await source.messages(channelId, end === 'first' ? { limit, after: cursor } : { limit, ...(cursor && { before: cursor }) })).sort(byId)
        if (!page.length) break
        if (end === 'first') { out.push(...page); cursor = page.at(-1)!.id }
        else { out.unshift(...page); cursor = page[0].id }
        if (page.length < limit) break
    }
    return out
}

export const render = (channelId: string, messages: ChatMessage[]) => messages.map(m => line(channelId, m)).join('\n')

const fail = (code: string, path: string) => Promise.reject(Object.assign(new Error(`${code}: ${path}`), { code }))
const dir = { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o555, size: 0, mtime: new Date() }
const file = { ...dir, isFile: true, isDirectory: false, mode: 0o444 }

export const createChatFs = (source: Source) => {
    const cache = new Map<string, Uint8Array>()
    const kind = (path: string) => {
        if (['/', '/channel', '/attachment'].includes(path) || /^\/attachment\/\d+(\/\d+)?$/.test(path)) return 'dir'
        if (path === '/channels.md' || /^\/channel\/\d+\.md$/.test(path) || /^\/attachment\/\d+\/\d+\/[^/]+$/.test(path)) return 'file'
        return null
    }
    const bytes = async (path: string): Promise<Uint8Array> => {
        if (path === '/channels.md') return new TextEncoder().encode((await source.channels()).map(c => `- ${c.where} #${c.name} → /chat/channel/${c.id}.md`).join('\n') + '\n')
        const channel = path.match(/^\/channel\/(\d+)\.md$/)?.[1]
        if (channel) {
            const header = `# channel ${channel}: last ${recent} messages. \`tail -n N\` / \`head -n N\` this file to fetch more (up to ${maxFetch}).\n`
            return new TextEncoder().encode(header + render(channel, await fetchEnd(source, channel, recent, 'last')) + '\n')
        }
        const [, channelId, messageId, name] = path.match(/^\/attachment\/(\d+)\/(\d+)\/([^/]+)$/) ?? []
        if (!name) return fail('ENOENT', path)
        if (!cache.has(path)) {
            const attachment = (await source.message(channelId, messageId)).attachments.find(a => a.name === name)
            if (!attachment) return fail('ENOENT', path)
            cache.set(path, await source.download(attachment.url))
        }
        return cache.get(path)!
    }
    const readonly = (path: string) => fail('EROFS', path)
    const fs = {
        async readdir(path: string) {
            if (path === '/') return ['channels.md', 'channel', 'attachment']
            if (path === '/channel') return (await source.channels()).map(c => `${c.id}.md`)
            const [, channelId, messageId] = path.match(/^\/attachment\/(\d+)\/(\d+)$/) ?? []
            if (messageId) return (await source.message(channelId, messageId)).attachments.map(a => a.name)
            if (kind(path) === 'dir') return []
            return fail('ENOTDIR', path)
        },
        readFileBuffer: bytes,
        async readFile(path: string) { return new TextDecoder().decode(await bytes(path)) },
        async stat(path: string) { const k = kind(path); return k === 'dir' ? dir : k === 'file' ? file : fail('ENOENT', path) },
        async lstat(path: string) { return fs.stat(path) },
        async exists(path: string) { return kind(path) !== null },
        resolvePath: (base: string, path: string) => path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
        getAllPaths: () => [],
        writeFile: readonly, appendFile: readonly, mkdir: readonly, rm: readonly, cp: readonly, mv: readonly,
        chmod: readonly, symlink: readonly, link: readonly, readlink: readonly,
    }
    return { fs, source }
}

const toChat = (m: Message): ChatMessage => ({
    id: m.id, content: m.content, at: m.createdTimestamp,
    author: { id: m.author.id, name: m.member?.displayName ?? m.author.username, bot: m.author.bot || !!m.webhookId },
    ...(m.reference?.messageId && { replyTo: m.reference.messageId }),
    attachments: [...m.attachments.values()].map(a => ({ name: a.name, url: a.url })),
})

export const discordSource = (client: Client): Source => {
    const textChannel = async (id: string) => {
        const channel = await client.channels.fetch(id)
        if (!channel?.isTextBased()) throw new Error(`${id} is not a text channel`)
        return channel
    }
    return {
        async channels() {
            return [...client.guilds.cache.values()].flatMap(guild => [...guild.channels.cache.values()]
                .filter(c => c.isTextBased() && !!c.permissionsFor(client.user!)?.has(['ViewChannel', 'ReadMessageHistory']))
                .map(c => ({ id: c.id, name: c.name, where: guild.name })))
        },
        async messages(channelId, page) {
            return [...(await (await textChannel(channelId)).messages.fetch(page)).values()].map(toChat)
        },
        async message(channelId, messageId) {
            return toChat(await (await textChannel(channelId)).messages.fetch(messageId))
        },
        async download(url) {
            const response = await fetch(url)
            if (!response.ok) throw new Error(`download failed: ${response.status}`)
            return new Uint8Array(await response.arrayBuffer())
        },
    }
}

export default (client: Client) => createChatFs(discordSource(client))
