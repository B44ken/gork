import { expect, test } from 'bun:test'
import { excerpt, find, matchRecent, normalizeEmoji, react } from '../bot/messages.ts'

const at = (minutes: number) => Date.UTC(2026, 10, 14, 12, minutes)
const message = (id: string, username: string, content: string, minutes: number, displayName?: string) => ({
    id, content, createdTimestamp: at(minutes), author: { id: `id-${username}`, username, displayName },
})

const messages = [
    message('1', 'alex', 'hello there', 0),
    message('2', 'brad', 'hello there again', 1, 'Bradley'),
    message('3', 'brad', 'unrelated chatter', 2, 'Bradley'),
]

test('finds messages by text and by author, newest first', () => {
    expect(matchRecent(messages, { query: 'HELLO' }).map(m => m.id)).toEqual(['2', '1'])
    expect(matchRecent(messages, { author: 'alex' }).map(m => m.id)).toEqual(['1'])
    expect(matchRecent(messages, { author: 'bradley' }).map(m => m.id)).toEqual(['3', '2'])
    expect(matchRecent(messages, { author: 'id-brad' }).map(m => m.id)).toEqual(['3', '2'])
    expect(matchRecent(messages, { query: 'hello', author: 'brad' }).map(m => m.id)).toEqual(['2'])
    expect(matchRecent(messages, { query: 'absent' })).toEqual([])
    expect(matchRecent(messages, { query: 'a', limit: 2 })).toHaveLength(2)
    expect(matchRecent(messages, { limit: 1000 })).toHaveLength(3)
    expect(matchRecent(messages, { limit: 0 }).map(m => m.id)).toEqual(['3'])
})

test('accepts a single emoji or a custom emoji and rejects everything else', () => {
    expect(normalizeEmoji('🎉')).toBe('🎉')
    expect(normalizeEmoji(' 👍🏽 ')).toBe('👍🏽')
    expect(normalizeEmoji('<:kappa:789>')).toBe('<:kappa:789>')
    expect(normalizeEmoji('kappa:789')).toBe('kappa:789')
    expect(normalizeEmoji('')).toBeNull()
    expect(normalizeEmoji('too many words')).toBeNull()
    expect(normalizeEmoji('🎉🎉')).toBeNull()
    expect(normalizeEmoji('x'.repeat(101))).toBeNull()
})

test('flattens message content for display', () => {
    expect(excerpt('  hello\n\n  world  ')).toBe('hello world')
    expect(excerpt('word '.repeat(80), 10)).toBe('word word …')
})

const channel = (messages: Map<string, any>) => ({
    id: 'channel', name: 'general', guildId: 'guild', isThread: () => false, rateLimitPerUser: 0,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async (first: any) => typeof first === 'string' ? messages.get(first) : new Map([...messages].slice(-first.limit)) },
})

const current = (target: any) => ({
    id: 'current', author: { id: 'user', username: 'user', bot: false }, webhookId: null, channelId: 'channel', channel: target,
    guild: { id: 'guild', members: { fetch: async ({ user }: any) => ({ id: user, isCommunicationDisabled: () => false }) } },
})

const client = { user: { id: 'bot' }, channels: { fetch: async () => null } } as any
const chat = (message: any, reply?: any) => ({ history: [], next: { id: 'user', name: 'user', msg: 'x' }, channel: 'general', message, reply } as any)

const entry = (id: string, username: string, content: string, minutes: number, reacted: string[] = []) => ({
    id, content, createdTimestamp: at(minutes), attachments: new Map(), url: `https://discord.com/channels/guild/channel/${id}`,
    author: { id: username, username }, react: async (emoji: string) => { reacted.push(emoji) },
})

test('reacts to the replied-to message and finds messages by text', async () => {
    const reacted: string[] = []
    const target = entry('target', 'alex', 'hello there', 0, reacted)
    const map = new Map([['target', target], ['other', entry('other', 'brad', 'unrelated', 1)]])
    const message = current(channel(map))

    const result = await react({ emoji: '🎉', message_id: null, channel_id: null }, chat(message, { messageId: 'target', authorId: 'alex', author: 'alex', content: 'hello there' }), client)
    expect(result).toMatchObject({ reacted: '🎉', message_id: 'target', author: 'alex', content: 'hello there' })
    expect(reacted).toEqual(['🎉'])

    expect(await react({ emoji: 'too many words', message_id: null, channel_id: null }, chat(message), client)).toContain('unsupported emoji')

    const found = await find({ query: 'HELLO', author: null, message_id: null, channel_id: null, limit: 5 }, chat(message), client) as any
    expect(found.channel).toBe('general')
    expect(found.scanned).toBe(2)
    expect(found.matches.map((match: any) => [match.id, match.author, match.content])).toEqual([['target', 'alex', 'hello there']])
    expect(found.matches[0].url).toContain('/channel/target')
})

test('searches by author and reads one message id', async () => {
    const map = new Map([['a', entry('a', 'alex', 'first', 0)], ['b', entry('b', 'brad', 'second', 1)]])
    const message = current(channel(map))
    const byAuthor = await find({ query: null, author: 'brad', message_id: null, channel_id: null, limit: 10 }, chat(message), client) as any
    expect(byAuthor.matches.map((match: any) => match.id)).toEqual(['b'])
    const single = await find({ query: null, author: null, message_id: 'a', channel_id: null, limit: 10 }, chat(message), client) as any
    expect(single).toMatchObject({ id: 'a', content: 'first' })
    expect(await find({ query: 'nothing', author: null, message_id: null, channel_id: null, limit: 10 }, chat(message), client)).toContain('no messages matched')
})
