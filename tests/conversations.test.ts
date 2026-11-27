import { describe, expect, test } from 'bun:test'
import { applyFilters, buildConversations, cleanContent, datasetStats, parseArchive, sortConversations, toJsonl, toRow, type ArchiveMessage } from '../scripts/conversations.ts'

const start = Date.UTC(2026, 7, 1, 12, 0)
const message = (id: string, authorId: string, content: string, minutes: number, overrides: Partial<ArchiveMessage> = {}): ArchiveMessage => ({
    id,
    channel: { id: 'c1', name: 'general', category: 'community!', thread: false },
    author: { id: authorId, username: authorId, display_name: authorId, bot: false },
    timestamp: new Date(start + minutes * 60_000).toISOString(),
    edited: null,
    content,
    reply_to: null,
    attachments: [],
    embeds: [],
    reactions: [],
    stickers: [],
    ...overrides,
})

describe('buildConversations', () => {
    test('groups by channel and gap, merges runs from one author, assigns alternating roles', () => {
        const conversations = buildConversations([
            message('1', 'alice', 'hey', 0),
            message('2', 'alice', 'anyone here', 1),
            message('3', 'bob', 'yes me', 2),
            message('4', 'carol', 'also me', 3),
            message('5', 'bob', 'cool', 4),
            message('6', 'alice', 'later', 240),
            message('7', 'bob', 'much later', 241),
        ])
        expect(conversations).toHaveLength(2)
        const [first, second] = conversations
        expect(first.turns.map(turn => [turn.role, turn.author.id, turn.content])).toEqual([
            ['user', 'alice', 'hey\nanyone here'],
            ['assistant', 'bob', 'yes me'],
            ['user', 'carol', 'also me'],
            ['assistant', 'bob', 'cool'],
        ])
        expect(first.turns[0].ids).toEqual(['1', '2'])
        expect(first.participants).toBe(3)
        expect(first.chars).toBe(first.turns.reduce((total, turn) => total + turn.content.length, 0))
        expect(second.turns.map(turn => turn.author.id)).toEqual(['alice', 'bob'])
    })

    test('splits channels and drops unanswered trailing turns', () => {
        const conversations = buildConversations([
            message('1', 'alice', 'hello', 0),
            message('2', 'bob', 'hi', 1),
            message('3', 'alice', 'no answer for this', 2),
            message('4', 'alice', 'other channel', 0, { channel: { id: 'c2', name: 'off-topic', category: null, thread: true } }),
            message('5', 'bob', 'reply', 1, { channel: { id: 'c2', name: 'off-topic', category: null, thread: true } }),
        ])
        expect(conversations).toHaveLength(2)
        const general = conversations.find(conversation => conversation.channel.id === 'c1')!
        expect(general.turns.map(turn => turn.content)).toEqual(['hello', 'hi'])
        expect(conversations.find(conversation => conversation.channel.id === 'c2')!.channel.thread).toBe(true)
    })

    test('excludes bot messages and empty messages', () => {
        const bot = { id: 'bot', username: 'bot', display_name: 'bot', bot: true }
        const conversations = buildConversations([
            message('1', 'alice', 'hello', 0),
            message('2', 'bot', 'beep', 1, { author: bot }),
            message('3', 'bob', 'hi', 2),
            message('4', 'bob', '   ', 3),
        ])
        expect(conversations[0].turns.map(turn => turn.content)).toEqual(['hello', 'beep'])
        const withoutBots = buildConversations([
            message('1', 'alice', 'hello', 0),
            message('2', 'bot', 'beep', 1, { author: bot }),
            message('3', 'bob', 'hi', 2),
        ], { includeBots: false })
        expect(withoutBots[0].turns.map(turn => turn.content)).toEqual(['hello', 'hi'])
        expect(withoutBots[0].participants).toBe(2)
    })

    test('turns attachment-only messages into a placeholder', () => {
        const [conversation] = buildConversations([
            message('1', 'alice', '', 0, { attachments: [{ id: 'a', filename: 'notes.pdf', size: 12, type: 'application/pdf', url: 'https://cdn/x' }] }),
            message('2', 'bob', 'got it', 1),
        ])
        expect(conversation.turns[0].content).toBe('[attachment: notes.pdf]')
        expect(conversation.turns[0].attachments).toBe(1)
    })
})

describe('filters and sorting', () => {
    const conversations = buildConversations([
        message('1', 'alice', 'does anyone have the mat137 notes', 0),
        message('2', 'bob', 'yes here you go', 1),
        message('3', 'carol', 'unrelated chatter about lunch', 120, { channel: { id: 'c2', name: 'off-topic', category: null, thread: false } }),
        message('4', 'dave', 'sandwiches', 121, { channel: { id: 'c2', name: 'off-topic', category: null, thread: false } }),
    ])

    test('searches text and channel names', () => {
        expect(applyFilters(conversations, { q: 'MAT137' })).toHaveLength(1)
        expect(applyFilters(conversations, { q: 'off-topic' })[0].channel.id).toBe('c2')
    })

    test('filters by channel, participants, length and authors', () => {
        expect(applyFilters(conversations, { channels: ['c2'] })).toHaveLength(1)
        expect(applyFilters(conversations, { minChars: 45 })).toHaveLength(1)
        expect(applyFilters(conversations, { maxChars: 40 })).toHaveLength(1)
        expect(applyFilters(conversations, { authors: ['carol'] })).toHaveLength(1)
        expect(applyFilters(conversations, { minTurns: 5 })).toHaveLength(0)
    })

    test('filters by date range and attachments', () => {
        const from = new Date(start + 60 * 60_000).toISOString()
        expect(applyFilters(conversations, { from })).toHaveLength(1)
        expect(applyFilters(conversations, { to: new Date(start).toISOString() })).toHaveLength(1)
        expect(applyFilters(conversations, { hasAttachments: 'yes' })).toHaveLength(0)
        expect(applyFilters(conversations, { hasAttachments: 'no' })).toHaveLength(2)
    })

    test('sorts by date, length and message count', () => {
        expect(sortConversations(conversations, 'newest')[0].channel.id).toBe('c2')
        expect(sortConversations(conversations, 'oldest')[0].channel.id).toBe('c1')
        expect(sortConversations(conversations, 'longest')[0].channel.id).toBe('c1')
        expect(sortConversations(conversations, 'messages')[0].channel.id).toBe('c1')
    })
})

describe('exports', () => {
    const [conversation] = buildConversations([
        message('1', 'alice', 'hello there', 0),
        message('2', 'bob', 'general kenobi', 1),
    ])

    test('renders chatml rows with an optional system prompt and metadata', () => {
        expect(toRow(conversation, 'chatml')).toEqual({ messages: [
            { role: 'user', content: 'hello there' },
            { role: 'assistant', content: 'general kenobi' },
        ] })
        const row = toRow(conversation, 'chatml', { system: 'be nice', metadata: true })
        expect((row.messages as any[])[0]).toEqual({ role: 'system', content: 'be nice' })
        expect((row.meta as any).channel).toBe('general')
    })

    test('renders sharegpt rows with human/gpt names', () => {
        const row = toRow(conversation, 'sharegpt', { system: 'be nice' })
        expect(row.conversations).toEqual([
            { from: 'system', value: 'be nice' },
            { from: 'human', value: 'hello there' },
            { from: 'gpt', value: 'general kenobi' },
        ])
    })

    test('writes one JSON line per conversation and reports stats', () => {
        const lines = toJsonl([conversation, conversation], 'chatml').trim().split('\n')
        expect(lines).toHaveLength(2)
        expect(JSON.parse(lines[0]).messages[0].role).toBe('user')
        expect(datasetStats([conversation])).toMatchObject({ conversations: 1, turns: 2, averageChars: 13, longestChars: 25 })
        expect(toJsonl([], 'chatml')).toBe('')
    })
})

describe('helpers', () => {
    test('parses jsonl archives and skips blank lines', () => {
        expect(parseArchive(`${JSON.stringify(message('1', 'a', 'x', 0))}\n\n`)).toHaveLength(1)
        expect(() => parseArchive('{nope')).toThrow('invalid JSON on line 1')
    })

    test('cleans discord markup', () => {
        expect(cleanContent('<@123> look at <#456> <:kappa:789> <@&321>')).toBe('@user look at #channel :kappa: @role')
        expect(cleanContent('a\n\n\n\nb  ')).toBe('a\n\nb')
    })
})
