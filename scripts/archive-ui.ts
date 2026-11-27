// Local browser for exports/*.jsonl, with filters and Unsloth dataset export.
//   bun scripts/archive-ui.ts [--port 6768] [--host 127.0.0.1] [--file <name>.jsonl]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { applyFilters, buildConversations, datasetStats, parseArchive, sortConversations, toJsonl, type ArchiveMessage, type BuildOptions, type Conversation, type ExportFormat, type Filters, type SortKey } from './conversations.ts'

const root = resolve(import.meta.dir, '..')
const exportsDir = join(root, 'exports')
const siteDir = join(root, 'site')

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
    const index = args.indexOf(`--${name}`)
    const value = args[index + 1]
    return value && !value.startsWith('--') ? value : fallback
}
const port = Number(flag('port', '6768'))
const hostname = flag('host', '127.0.0.1')
const preferred = flag('file', '')

const archives = () => existsSync(exportsDir)
    ? readdirSync(exportsDir).filter(file => file.endsWith('.jsonl')).map(file => join(exportsDir, file))
    : []

const archivePath = (requested: string | null) => {
    const files = archives()
    if (requested && files.some(file => basename(file) === requested)) return join(exportsDir, requested)
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
}

const messageCache = new Map<string, { mtimeMs: number, messages: ArchiveMessage[] }>()
const loadMessages = (path: string) => {
    const { mtimeMs } = statSync(path)
    const cached = messageCache.get(path)
    if (cached?.mtimeMs === mtimeMs) return cached.messages
    const messages = parseArchive(readFileSync(path, 'utf8'))
    messageCache.set(path, { mtimeMs, messages })
    return messages
}

const conversationCache = new Map<string, Conversation[]>()
const conversationsFor = (path: string, build: Required<BuildOptions>) => {
    const key = `${path}|${build.gapMinutes}|${build.includeBots}|${build.clean}|${build.dropUnanswered}|${statSync(path).mtimeMs}`
    const cached = conversationCache.get(key)
    if (cached) return cached
    const conversations = buildConversations(loadMessages(path), build)
    if (conversationCache.size >= 8) conversationCache.delete(conversationCache.keys().next().value!)
    conversationCache.set(key, conversations)
    return conversations
}

const parseQuery = (url: URL) => {
    const list = (name: string) => (url.searchParams.get(name) ?? '').split(',').map(item => item.trim()).filter(Boolean)
    const number = (name: string, fallback: number) => {
        const raw = url.searchParams.get(name)
        if (raw === null || raw.trim() === '') return fallback
        const value = Number(raw)
        return Number.isFinite(value) ? Math.max(0, value) : fallback
    }
    const attachments = url.searchParams.get('attachments')
    const sort = url.searchParams.get('sort')
    const build: Required<BuildOptions> = {
        gapMinutes: Math.max(1, number('gap', 30)),
        includeBots: url.searchParams.get('includeBots') !== '0',
        clean: url.searchParams.get('clean') !== '0',
        dropUnanswered: url.searchParams.get('dropUnanswered') !== '0',
    }
    const filters: Filters = {
        q: url.searchParams.get('q') ?? '',
        channels: list('channels'),
        authors: list('authors'),
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        minTurns: number('minTurns', 2),
        minChars: number('minChars', 0),
        maxChars: number('maxChars', 0),
        minParticipants: number('minParticipants', 2),
        minMessages: number('minMessages', 0),
        hasAttachments: attachments === 'yes' || attachments === 'no' ? attachments : 'any',
    }
    const sortKey: SortKey = sort === 'oldest' || sort === 'longest' || sort === 'messages' ? sort : 'newest'
    return { build, filters, sort: sortKey }
}

const exportShape = (url: URL) => ({
    format: (url.searchParams.get('format') === 'sharegpt' ? 'sharegpt' : 'chatml') as ExportFormat,
    system: url.searchParams.get('system') ?? '',
    metadata: url.searchParams.get('metadata') === '1',
})

const selected = (path: string, query: ReturnType<typeof parseQuery>) =>
    sortConversations(applyFilters(conversationsFor(path, query.build), query.filters), query.sort)

const meta = (path: string) => {
    const messages = loadMessages(path)
    const channels = new Map<string, ArchiveMessage['channel'] & { messages: number }>()
    const authors = new Map<string, ArchiveMessage['author'] & { messages: number }>()
    let from = '', to = ''
    for (const message of messages) {
        const channel = channels.get(message.channel.id) ?? { ...message.channel, messages: 0 }
        channel.messages++
        channels.set(message.channel.id, channel)
        const author = authors.get(message.author.id) ?? { ...message.author, messages: 0 }
        author.messages++
        authors.set(message.author.id, author)
        if (!from || message.timestamp < from) from = message.timestamp
        if (!to || message.timestamp > to) to = message.timestamp
    }
    const byCount = (a: { messages: number }, b: { messages: number }) => b.messages - a.messages
    return {
        file: basename(path),
        files: archives()
            .map(file => ({ name: basename(file), messages: loadMessages(file).length, modified: statSync(file).mtimeMs }))
            .sort((a, b) => b.modified - a.modified),
        messages: messages.length,
        from,
        to,
        channels: [...channels.values()].sort(byCount),
        authors: [...authors.values()].sort(byCount),
    }
}

const assets: Record<string, [string, string]> = {
    '/': ['archive.html', 'text/html'],
    '/archive.html': ['archive.html', 'text/html'],
    '/archive.css': ['archive.css', 'text/css'],
    '/archive.js': ['archive.js', 'text/javascript'],
}

Bun.serve({ hostname, port, async fetch(request) {
    const url = new URL(request.url)
    const headers = {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    }
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } })

    const asset = assets[url.pathname]
    if (request.method === 'GET' && asset) {
        return new Response(readFileSync(join(siteDir, asset[0])), { headers: { ...headers, 'Content-Type': `${asset[1]}; charset=utf-8` } })
    }

    const path = archivePath(url.searchParams.get('file') ?? preferred)
    if (!path) return json({ error: 'no archive found in exports/; run `bun scripts/archive-messages.ts` first' }, 404)

    if (request.method === 'GET' && url.pathname === '/api/meta') return json(meta(path))

    if (request.method === 'GET' && url.pathname === '/api/conversations') {
        const query = parseQuery(url)
        const conversations = selected(path, query)
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
        return json({
            total: conversations.length,
            offset,
            limit,
            stats: datasetStats(conversations),
            conversations: conversations.slice(offset, offset + limit),
        })
    }

    if (request.method === 'GET' && url.pathname === '/api/export') {
        const conversations = selected(path, parseQuery(url))
        const shape = exportShape(url)
        const name = `${shape.format}-${basename(path, '.jsonl')}.jsonl`
        return new Response(toJsonl(conversations, shape.format, shape), {
            headers: {
                ...headers,
                'Content-Type': 'application/jsonl; charset=utf-8',
                'Content-Disposition': `attachment; filename="${name}"`,
            },
        })
    }

    if (request.method === 'POST' && url.pathname === '/api/save') {
        // Writes a file, so require a same-origin JSON request like the bot dashboard does.
        if (request.headers.get('origin') !== url.origin || request.headers.get('content-type') !== 'application/json') {
            return json({ error: 'invalid request origin or content type' }, 403)
        }
        const body = await request.json().catch(() => ({})) as { query?: string, name?: string }
        const target = new URL(`/api/export?${body.query ?? ''}`, url.origin)
        const conversations = selected(path, parseQuery(target))
        const shape = exportShape(target)
        const safe = (body.name ?? '').trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const folder = join(exportsDir, 'datasets')
        mkdirSync(folder, { recursive: true })
        const base = `${safe || `${shape.format}-${basename(path, '.jsonl')}`}-${stamp}`
        let file = join(folder, `${base}.jsonl`)
        for (let index = 2; existsSync(file); index++) file = join(folder, `${base}-${index}.jsonl`)
        const content = toJsonl(conversations, shape.format, shape)
        writeFileSync(file, content)
        const stats = datasetStats(conversations)
        writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
            source: basename(path),
            format: shape.format,
            system: shape.system || null,
            metadata: shape.metadata,
            filters: parseQuery(target).filters,
            build: parseQuery(target).build,
            stats,
            file: file.slice(root.length + 1),
        }, null, 2))
        return json({ file: file.slice(root.length + 1), bytes: Buffer.byteLength(content), lines: stats.conversations, stats })
    }

    return json({ error: 'not found' }, 404)
} })

console.log(`archive viewer on http://${hostname}:${port} (archives: ${archives().map(file => basename(file)).join(', ') || 'none'})`)
