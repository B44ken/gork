import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let request: any
let patchRuns = 0
let onMessage: (chat: any) => Promise<string>
let invokePatch = false
mock.module('../bot/codex.ts', () => ({ run: async (options: any) => {
    request = options
    if (invokePatch) return { finalResponse: await options.callTool('monkeypatch', { task: 'fix the bug', effort: null }) }
    return { finalResponse: 'done' }
} }))
mock.module('@openai/codex-sdk', () => ({ Codex: class {
    startThread() { return { id: 'test', run: async () => {
        patchRuns++
        return { finalResponse: JSON.stringify({ completed: false, summary: 'edited' }), usage: null }
    } } }
} }))
const bot = {
    client: { user: { id: 'clod' }, application: { owner: { id: '143771295832735745' } } },
    name: () => 'clod', moderate() {}, command() {},
    message(handler: typeof onMessage) { onMessage = handler }, ready() {},
    memoryUsers: async () => [],
}
mock.module('../bot/bot.ts', () => ({
    createBot: () => bot, ...bot,
    client: bot.client, string: {}, integer: {}, number: {}, user: {},
    optional: (x: any) => x, oneOf: (x: any) => x,
}))

test('ordinary owner requests can invoke monkeypatch while persona tools remain public', async () => {
    const original = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), 'clod-patch-'))
    const previousKey = process.env.EXA_API_KEY, previousPort = process.env.GORK_PORT
    process.env.EXA_API_KEY = 'integration-fixture'
    process.env.GORK_PORT = '0'
    let instances: ReturnType<typeof import('../bot/main.ts').start>
    process.chdir(dir)
    try {
        writeFileSync('db.json', JSON.stringify({ facts: {} }))
        instances = (await import('../bot/main.ts')).start('/nonexistent-instances.json')
        const ai = instances[0].ai
        const context = (id: string, bot = false, webhookId: string | null = null) => ({
            message: { author: { id, bot }, content: 'please edit the code', webhookId },
            history: [], next: { id, name: 'member', msg: 'please edit the code' }, channel: '',
        }) as any
        const owner = '143771295832735745'
        const ownerChat = context(owner)
        ownerChat.message.content = 'please fix the bug'
        ownerChat.next.msg = 'please fix the bug'
        invokePatch = true
        expect(await onMessage(ownerChat)).toBe('edited')
        invokePatch = false
        // The persona is the whole system prompt; monkeypatch guidance now lives in the tool description.
        expect(request.instructions).toContain('you are clod')
        expect(request.instructions).toContain('your messages must be brief.')
        expect(request.tools.find((tool: any) => tool.name === 'monkeypatch').description).toContain('no command or prefix is required')
        for (const [id, bot, webhook, allowed] of [
            [owner, false, null, true], ['other', false, null, false],
            [owner, true, null, false], [owner, false, 'webhook', false],
        ] as const) {
            await ai.get(context(id, bot, webhook), '', [])
            const names = request.tools.map((tool: any) => tool.name)
            expect(names.includes('monkeypatch')).toBe(allowed)
            expect(names.includes('view-persona')).toBe(true)
            expect(names.includes('set-persona')).toBe(true)
            expect(names.includes('reset-persona')).toBe(true)
            expect(names.includes('view-channel-reply-limit')).toBe(allowed)
            expect(names.includes('set-channel-reply-limit')).toBe(allowed)
            expect(names.includes('reset-channel-reply-limit')).toBe(allowed)
            const result = await request.callTool('monkeypatch', { task: 'edit code', effort: null })
            expect(result).toBe(allowed ? 'edited' : 'tool unavailable for this sender; only the owner can use owner-only tools')
            if (!allowed) {
                expect(await request.callTool('set-persona', { content: 'public persona' })).toContain('updated')
                expect(await request.callTool('view-persona', {})).toBe('public persona')
                expect(await request.callTool('reset-persona', {})).toContain('reset')
            }
        }
        expect(patchRuns).toBe(2)
        await ai.get(ownerChat, '')
        expect(await request.callTool('set-persona', { content: 'public persona' })).toContain('updated')
        expect(await request.callTool('view-persona', {})).toBe('public persona')
        expect(await request.callTool('reset-persona', {})).toContain('reset')
    } finally {
        await instances!.at(0)!.stop()
        if (previousKey === undefined) delete process.env.EXA_API_KEY
        else process.env.EXA_API_KEY = previousKey
        if (previousPort === undefined) delete process.env.GORK_PORT
        else process.env.GORK_PORT = previousPort
        process.chdir(original)
        rmSync(dir, { recursive: true, force: true })
    }
})
