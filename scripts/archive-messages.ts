// One-off archive of guild messages with the bot token from .env.local.
//   bun scripts/archive-messages.ts --list
//   bun scripts/archive-messages.ts [--guild <id or name>] [--days 28] [--out exports/<file>.jsonl]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const token = Bun.env.DISCORD_TOKEN
if (!token) {
    console.error('DISCORD_TOKEN is not set (run from a directory with .env.local)')
    process.exit(1)
}

const API = 'https://discord.com/api/v10'
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`)
    if (index === -1) return undefined
    const value = args[index + 1]
    return value && !value.startsWith('--') ? value : undefined
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function api(path: string, attempt = 0): Promise<any> {
    const response = await fetch(API + path, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://github.com/brad/gork, 1.0)' },
    })
    if (response.status === 429 && attempt < 5) {
        const body = await response.json().catch(() => ({})) as any
        const wait = Number(body.retry_after ?? 1)
        console.log(`rate limited on ${path}; waiting ${wait}s`)
        await sleep(wait * 1000 + 250)
        return api(path, attempt + 1)
    }
    if (response.status === 403) throw new Error(`missing access to ${path}`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${path}`)
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = response.headers.get('x-ratelimit-reset-after')
    if (remaining === '0' && reset) await sleep(Number(reset) * 1000 + 100)
    return response.json()
}

const guilds = await api('/users/@me/guilds') as any[]
if (args.includes('--list')) {
    for (const guild of guilds) {
        const channels = await api(`/guilds/${guild.id}/channels`) as any[]
        const threads = await api(`/guilds/${guild.id}/threads/active`).catch(() => ({ threads: [] })) as any
        console.log(JSON.stringify({
            guild: { id: guild.id, name: guild.name },
            channels: channels.filter((channel: any) => [0, 5, 15].includes(channel.type)).map((channel: any) => ({ id: channel.id, name: channel.name, type: channel.type })),
            categories: channels.filter((channel: any) => channel.type === 4).map((channel: any) => channel.name),
            voice: channels.filter((channel: any) => channel.type === 2).length,
            activeThreads: (threads.threads ?? []).length,
        }, null, 2))
    }
    process.exit(0)
}

const wanted = flag('guild')
const guild = wanted
    ? guilds.find(item => item.id === wanted || item.name.toLowerCase().includes(wanted.toLowerCase()))
    : guilds.find(item => /math/i.test(item.name))
if (!guild) {
    console.error(wanted ? `no guild matching ${wanted}` : 'no guild matching /math/i; pass --guild')
    console.error(guilds.map(item => `${item.id} ${item.name}`).join('\n'))
    process.exit(1)
}

const days = Number(flag('days') ?? 28)
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
const cutoffIso = new Date(cutoff).toISOString()
const out = flag('out') ?? `exports/${guild.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.jsonl`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, '')

const channels = await api(`/guilds/${guild.id}/channels`) as any[]
const categories = new Map(channels.filter((channel: any) => channel.type === 4).map((channel: any) => [channel.id, channel.name]))
const active = await api(`/guilds/${guild.id}/threads/active`).catch(() => ({ threads: [] })) as any

type Target = { id: string, name: string, parent: string | null, thread: boolean }

const targets: Target[] = channels
    .filter((channel: any) => [0, 5, 15].includes(channel.type))
    .map((channel: any) => ({ id: channel.id, name: channel.name, parent: categories.get(channel.parent_id) ?? null, thread: false }))

for (const thread of active.threads ?? []) {
    targets.push({ id: thread.id, name: thread.name, parent: categories.get(thread.parent_id) ?? null, thread: true })
}

// Archived threads are only exposed per parent channel, newest archive first.
for (const parent of channels.filter((channel: any) => [0, 5, 15].includes(channel.type))) {
    let before: string | undefined
    for (;;) {
        const query = `/channels/${parent.id}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`
        const page = await api(query).catch((error: Error) => {
            console.log(`skipping archived threads of ${parent.name}: ${error.message}`)
            return { threads: [], has_more: false }
        }) as any
        for (const thread of page.threads ?? []) {
            if (Date.parse(thread.thread_metadata?.archive_timestamp ?? 0) < cutoff) continue
            targets.push({ id: thread.id, name: thread.name, parent: categories.get(thread.parent_id) ?? null, thread: true })
        }
        const oldest = page.threads?.at(-1)
        if (!page.has_more || !oldest) break
        before = oldest.thread_metadata?.archive_timestamp
        if (!before || Date.parse(before) < cutoff) break
    }
}

const seen = new Set(targets.map(target => target.id))
const sink = (target: Target, message: any) => appendFileSync(out, JSON.stringify({
    id: message.id,
    channel: { id: target.id, name: target.name, category: target.parent, thread: target.thread },
    author: {
        id: message.author.id,
        username: message.author.username,
        display_name: message.author.global_name ?? message.author.username,
        bot: Boolean(message.author.bot),
    },
    timestamp: message.timestamp,
    edited: message.edited_timestamp,
    content: message.content,
    reply_to: message.message_reference?.message_id ?? message.referenced_message?.id ?? null,
    attachments: (message.attachments ?? []).map((attachment: any) => ({ id: attachment.id, filename: attachment.filename, size: attachment.size, type: attachment.content_type, url: attachment.url })),
    embeds: (message.embeds ?? []).map((embed: any) => ({ type: embed.type, title: embed.title, url: embed.url, description: embed.description })),
    reactions: (message.reactions ?? []).map((reaction: any) => ({ emoji: reaction.emoji?.name, count: reaction.count })),
    stickers: (message.sticker_items ?? []).map((sticker: any) => sticker.name),
}) + '\n')

const counts: Record<string, number> = {}
let total = 0
for (const target of targets) {
    if (!seen.has(target.id)) continue
    seen.delete(target.id)
    let before: string | undefined, count = 0
    try {
        for (;;) {
            const batch = await api(`/channels/${target.id}/messages?limit=100${before ? `&before=${before}` : ''}`) as any[]
            if (!batch.length) break
            let reachedOlder = false
            for (const message of batch) {
                if (Date.parse(message.timestamp) < cutoff) { reachedOlder = true; continue }
                sink(target, message)
                count++
            }
            if (reachedOlder) break
            before = batch.at(-1).id
        }
    } catch (error) {
        console.log(`skipping #${target.name}: ${(error as Error).message}`)
    }
    if (count) counts[`${target.parent ? target.parent + ' / ' : ''}${target.name}`] = count
    total += count
    console.log(`${count.toString().padStart(5)}  ${target.parent ? target.parent + ' / ' : ''}${target.name}`)
}

writeFileSync(out.replace(/\.jsonl$/, '.summary.json'), JSON.stringify({
    guild: { id: guild.id, name: guild.name },
    window: { days, from: cutoffIso, to: new Date().toISOString() },
    total, channels: counts, file: out,
}, null, 2))
console.log(JSON.stringify({ guild: guild.name, window: cutoffIso, total, file: out }))
