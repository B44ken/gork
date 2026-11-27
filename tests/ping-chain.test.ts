import { expect, test } from 'bun:test'
import { threadRun, threadRunLimit } from '../bot/bot.ts'

const isBot = (message: any) => !!message.author?.bot
const node = (id: string, parent: any = null, bot = true) => ({
    id, author: { id, bot }, webhookId: null,
    reference: parent ? { messageId: parent.id } : null,
    fetchReference: async () => parent,
})

test('caps a bot ping chain at six messages', () => {
    expect(threadRunLimit).toBe(6)
})

test('counts the bot messages in a reply thread, newest first', async () => {
    const root = node('a')
    const second = node('b', root)
    const third = node('c', second)
    expect(await threadRun(root as any, isBot)).toBe(1)
    expect(await threadRun(second as any, isBot)).toBe(2)
    expect(await threadRun(third as any, isBot)).toBe(3)
})

test('a human message in the thread ends the run', async () => {
    const human = node('human', null, false)
    const botReply = node('clod', human)
    expect(await threadRun(human as any, isBot)).toBe(0)
    expect(await threadRun(botReply as any, isBot)).toBe(1)
})

test('stops counting at the limit', async () => {
    let current: any = node('root')
    for (let index = 1; index < 12; index++) current = node(String(index), current)
    expect(await threadRun(current, isBot)).toBe(6)
})

test('a deleted parent ends the run instead of failing', async () => {
    const missing = { id: 'gone', author: { id: 'gone', bot: true }, reference: { messageId: 'gone' }, fetchReference: async () => { throw new Error('Unknown Message') } }
    const reply = { id: 'reply', author: { id: 'reply', bot: true }, reference: { messageId: 'gone' }, fetchReference: missing.fetchReference }
    expect(await threadRun(reply as any, isBot)).toBe(1)
})
