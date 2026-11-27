// deploy runs these before any new code goes live, so they cover what would break the bot outright.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { defineCommand, decodeBytesToUtf8 } from 'just-bash'
import { createChatFs, type ChatMessage, type Source } from '../src/fs/chat.ts'
import { createShell, execute, type CommandContext } from '../src/shell.ts'
import tail from '../src/commands/tail.ts'
import head from '../src/commands/head.ts'
import { entries } from '../src/site/server.ts'

const root = join(import.meta.dir, '..')

// 250 messages with ids 1001..1250; every page request is recorded.
const fakeSource = () => {
    const all: ChatMessage[] = Array.from({ length: 250 }, (_, i) => ({
        id: String(1001 + i), content: `message ${i + 1}`, at: 0, author: { id: '7', name: 'alice', bot: false },
        attachments: i === 249 ? [{ name: 'cat.png', url: 'https://cdn/cat.png' }] : [],
    }))
    const pages: number[] = []
    const source: Source = {
        channels: async () => [{ id: '42', name: 'general', where: 'test guild' }],
        async messages(_, { limit, before, after }) {
            pages.push(limit)
            // discord.js uses timers inside its REST client; just-bash's sandbox guard used to block them.
            await new Promise(resolve => setTimeout(resolve, 1))
            const matching = all.filter(m => (!before || BigInt(m.id) < BigInt(before)) && (!after || BigInt(m.id) > BigInt(after)))
            return (after ? matching.slice(0, limit) : matching.slice(-limit)).toReversed()
        },
        message: async (_, id) => all.find(m => m.id === id)!,
        download: async () => new TextEncoder().encode('png bytes'),
    }
    return { source, pages }
}

const shell = (source: Source, sent: string[] = []) => {
    const chat = createChatFs(source)
    const context = { chat, images: [] } as unknown as CommandContext
    const discord = defineCommand('discord', async (args, ctx) => {
        sent.push(`${args.join(' ')} ${decodeBytesToUtf8(ctx.stdin).trim()}`)
        return { stdout: '{"id":"999"}\n', stderr: '', exitCode: 0 }
    })
    return createShell({ workspace: join(root, 'template'), root, chat, commands: [tail(context), head(context), discord], env: { CHANNEL: '42', MESSAGE: '1250' } })
}

test('channel files fetch only what is asked for', async () => {
    const { source, pages } = fakeSource()
    const bash = shell(source)
    expect((await execute(bash, 'tail -n 120 /chat/channel/42.md | wc -l')).trim()).toBe('120')
    expect(pages).toEqual([100, 20])
    expect((await execute(bash, 'head -n 2 /chat/channel/42.md')).trim().split('\n').map(l => l.slice(0, 6))).toEqual(['[1001]', '[1002]'])
    const window = await execute(bash, 'cat /chat/channel/42.md')
    expect(window.split('\n').filter(l => l.startsWith('[')).length).toBe(100)
    expect(window).toContain('[file: /chat/attachment/42/1250/cat.png]')
    expect(await execute(bash, 'cat /chat/attachment/42/1250/cat.png')).toBe('png bytes')
    expect(await execute(bash, 'echo hi > /chat/channel/42.md')).toContain('EROFS')
})

test('workspace scripts reach discord through PATH', async () => {
    const sent: string[] = []
    const bash = shell(fakeSource().source, sent)
    expect((await execute(bash, 'reply.sh "hi there"')).trim()).toBe('sent message 999')
    const [call] = sent
    expect(call.startsWith('POST /channels/42/messages ')).toBe(true)
    expect(JSON.parse(call.slice(call.indexOf('{')))).toMatchObject({ content: 'hi there', message_reference: { message_id: '1250' }, allowed_mentions: { parse: [] } })
    expect(await execute(bash, 'cat /src/package.json | jq -r .name')).toBe('gork\n')
    expect(await execute(bash, 'cat /src/../../etc/hosts')).toContain('No such file')
})

test('trace shows events, thinking, commands and output', () => {
    expect(entries([
        { type: 'user', message: { role: 'user', content: '[event] hi' } },
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'say hi back' }, { type: 'tool_use', input: { command: 'reply.sh hi' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'sent message 1' }] }] } },
    ])).toEqual([
        { kind: 'event', text: '[event] hi' }, { kind: 'thinking', text: 'say hi back' },
        { kind: 'command', text: 'reply.sh hi' }, { kind: 'output', text: 'sent message 1' },
    ])
})
