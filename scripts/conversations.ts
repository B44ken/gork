// Shapes the archived Discord messages written by scripts/archive-messages.ts into
// training conversations, filters them, and renders datasets for Unsloth.

export type ArchiveMessage = {
    id: string
    channel: { id: string, name: string, category: string | null, thread: boolean }
    author: { id: string, username: string, display_name: string, bot: boolean }
    timestamp: string
    edited: string | null
    content: string
    reply_to: string | null
    attachments: { id: string, filename: string, size: number, type: string | null, url: string }[]
    embeds: { type?: string, title?: string, url?: string, description?: string }[]
    reactions: { emoji?: string, count: number }[]
    stickers: string[]
}

export type Role = 'user' | 'assistant'

export type Turn = {
    role: Role
    author: ArchiveMessage['author']
    content: string
    ids: string[]
    timestamp: string
    attachments: number
}

export type Conversation = {
    id: string
    channel: ArchiveMessage['channel']
    turns: Turn[]
    messages: number
    chars: number
    participants: number
    startedAt: string
    endedAt: string
}

export type BuildOptions = {
    /** Minutes of silence that end a conversation. */
    gapMinutes?: number
    includeBots?: boolean
    /** Rewrite Discord markup (mentions, custom emoji) into plain text. */
    clean?: boolean
    /** Drop a trailing user turn that never got an answer. */
    dropUnanswered?: boolean
}

export type Filters = {
    q?: string
    channels?: string[]
    /** Keep conversations involving any of these authors. */
    authors?: string[]
    from?: string
    to?: string
    minTurns?: number
    minChars?: number
    maxChars?: number
    minParticipants?: number
    minMessages?: number
    hasAttachments?: 'any' | 'yes' | 'no'
}

export type SortKey = 'newest' | 'oldest' | 'longest' | 'messages'
export type ExportFormat = 'chatml' | 'sharegpt'

export const parseArchive = (text: string): ArchiveMessage[] =>
    text.split('\n').filter(line => line.trim()).map((line, index) => {
        try { return JSON.parse(line) as ArchiveMessage } catch { throw new Error(`invalid JSON on line ${index + 1}`) }
    })

export const cleanContent = (content: string) => content
    .replace(/\r\n?/g, '\n')
    .replace(/<a?:([a-zA-Z0-9_~]+):\d+>/g, (_match, name: string) => `:${name}:`)
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const attachmentText = (message: ArchiveMessage) => message.attachments.length
    ? `[attachment: ${message.attachments.map(attachment => attachment.filename).join(', ')}]`
    : ''

const hasContent = (message: ArchiveMessage) => message.content.trim().length > 0 || message.attachments.length > 0

const shape = (messages: ArchiveMessage[], clean: boolean, dropUnanswered: boolean): Conversation | null => {
    // The first two distinct speakers alternate user/assistant; later speakers join as human.
    const roles = new Map<string, Role>()
    const turns: Turn[] = []
    for (const message of messages) {
        let role = roles.get(message.author.id)
        if (!role) {
            role = roles.size % 2 === 0 ? 'user' : 'assistant'
            roles.set(message.author.id, role)
        }
        const content = (clean ? cleanContent(message.content) : message.content.trim()) || attachmentText(message)
        if (!content) continue
        // Merge runs by role, not just by author, so the transcript always alternates.
        const last = turns.at(-1)
        if (last && last.role === role) {
            last.content += '\n' + content
            last.ids.push(message.id)
            last.attachments += message.attachments.length
            last.timestamp = message.timestamp
            continue
        }
        turns.push({ role, author: message.author, content, ids: [message.id], timestamp: message.timestamp, attachments: message.attachments.length })
    }
    if (dropUnanswered) while (turns.at(-1)?.role === 'user') turns.pop()
    if (turns.length < 2) return null
    const first = messages[0]
    return {
        id: `${first.channel.id}:${first.id}`,
        channel: first.channel,
        turns,
        messages: messages.length,
        chars: turns.reduce((total, turn) => total + turn.content.length, 0),
        participants: roles.size,
        startedAt: first.timestamp,
        endedAt: messages.at(-1)!.timestamp,
    }
}

export const buildConversations = (messages: ArchiveMessage[], options: BuildOptions = {}): Conversation[] => {
    const gap = Math.max(1, options.gapMinutes ?? 30) * 60_000
    const includeBots = options.includeBots ?? true
    const clean = options.clean ?? true
    const dropUnanswered = options.dropUnanswered ?? true
    const byChannel = new Map<string, ArchiveMessage[]>()
    for (const message of messages) {
        if (!includeBots && message.author.bot) continue
        if (!hasContent(message)) continue
        const list = byChannel.get(message.channel.id)
        if (list) list.push(message)
        else byChannel.set(message.channel.id, [message])
    }
    const conversations: Conversation[] = []
    for (const list of byChannel.values()) {
        list.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id))
        let group: ArchiveMessage[] = []
        const flush = () => {
            const conversation = shape(group, clean, dropUnanswered)
            if (conversation) conversations.push(conversation)
            group = []
        }
        for (const message of list) {
            if (group.length && Date.parse(message.timestamp) - Date.parse(group.at(-1)!.timestamp) > gap) flush()
            group.push(message)
        }
        if (group.length) flush()
    }
    return conversations
}

export const applyFilters = (conversations: Conversation[], filters: Filters): Conversation[] => {
    const query = filters.q?.trim().toLowerCase() ?? ''
    const channels = new Set(filters.channels ?? [])
    const authors = new Set(filters.authors ?? [])
    const from = filters.from ? Date.parse(filters.from) : null
    const to = filters.to ? Date.parse(filters.to) : null
    const minTurns = filters.minTurns ?? 0
    const minChars = filters.minChars ?? 0
    const maxChars = filters.maxChars ?? 0
    const minParticipants = filters.minParticipants ?? 0
    const minMessages = filters.minMessages ?? 0
    const attachments = filters.hasAttachments ?? 'any'
    return conversations.filter(conversation => {
        if (channels.size && !channels.has(conversation.channel.id)) return false
        if (from !== null && Date.parse(conversation.endedAt) < from) return false
        if (to !== null && Date.parse(conversation.startedAt) > to) return false
        if (conversation.turns.length < minTurns) return false
        if (conversation.chars < minChars) return false
        if (maxChars && conversation.chars > maxChars) return false
        if (conversation.participants < minParticipants) return false
        if (conversation.messages < minMessages) return false
        if (authors.size && !conversation.turns.some(turn => authors.has(turn.author.id))) return false
        if (attachments === 'yes' && !conversation.turns.some(turn => turn.attachments)) return false
        if (attachments === 'no' && conversation.turns.some(turn => turn.attachments)) return false
        if (query) {
            const text = conversation.turns.map(turn => turn.content).join('\n').toLowerCase()
            if (!text.includes(query) && !conversation.channel.name.toLowerCase().includes(query)) return false
        }
        return true
    })
}

export const sortConversations = (conversations: Conversation[], sort: SortKey): Conversation[] => {
    const copy = [...conversations]
    const tiebreak = (a: Conversation, b: Conversation) => a.id.localeCompare(b.id)
    switch (sort) {
        case 'oldest': return copy.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || tiebreak(a, b))
        case 'longest': return copy.sort((a, b) => b.chars - a.chars || tiebreak(a, b))
        case 'messages': return copy.sort((a, b) => b.messages - a.messages || tiebreak(a, b))
        default: return copy.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || tiebreak(a, b))
    }
}

export type ExportOptions = { system?: string, metadata?: boolean }

export const toRow = (conversation: Conversation, format: ExportFormat, options: ExportOptions = {}): Record<string, unknown> => {
    const system = options.system?.trim()
    const row: Record<string, unknown> = format === 'sharegpt'
        ? {
            conversations: [
                ...(system ? [{ from: 'system', value: system }] : []),
                ...conversation.turns.map(turn => ({ from: turn.role === 'assistant' ? 'gpt' : 'human', value: turn.content })),
            ],
        }
        : {
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                ...conversation.turns.map(turn => ({ role: turn.role, content: turn.content })),
            ],
        }
    if (options.metadata) row.meta = {
        conversation: conversation.id,
        channel: conversation.channel.name,
        thread: conversation.channel.thread,
        started_at: conversation.startedAt,
        ended_at: conversation.endedAt,
        messages: conversation.messages,
        participants: conversation.participants,
    }
    return row
}

export const toJsonl = (conversations: Conversation[], format: ExportFormat, options: ExportOptions = {}) =>
    conversations.map(conversation => JSON.stringify(toRow(conversation, format, options))).join('\n') + (conversations.length ? '\n' : '')

export const datasetStats = (conversations: Conversation[]) => {
    const turns = conversations.reduce((total, conversation) => total + conversation.turns.length, 0)
    const chars = conversations.reduce((total, conversation) => total + conversation.chars, 0)
    return {
        conversations: conversations.length,
        turns,
        chars,
        averageChars: turns ? Math.round(chars / turns) : 0,
        longestChars: conversations.reduce((longest, conversation) => Math.max(longest, conversation.chars), 0),
    }
}
