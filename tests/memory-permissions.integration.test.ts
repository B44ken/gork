import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

test('memory slash commands and AI tools enforce owner and self-only mutation rules', () => {
    const script = `
        import { mock } from 'bun:test'
        const ownerId = '143771295832735745', memberId = '234567890123456789'
        const botId = '1569837392070836224', otherId = '345678901234567890'
        const commands = new Map(), tools = new Map()
        const bot = {
            client: { user: { id: botId }, application: { owner: { id: ownerId } } },
            name: () => 'clod', moderate() {}, message() {}, ready() {},
            command: (name, args, handler, options) => commands.set(name, { args, handler, options }),
        }
        mock.module(${JSON.stringify(join(root, 'bot/bot.ts'))}, () => ({
            createBot: () => bot, oneOf: value => value, optional: value => value, string: 'string',
        }))
        mock.module(${JSON.stringify(join(root, 'bot/ai.ts'))}, () => ({
            createAI: () => ({ tool: (name, description, params, handler, available = () => true) => tools.set(name, { description, params, handler, available }), get: async () => '' }),
        }))
        mock.module(${JSON.stringify(join(root, 'bot/usage.ts'))}, () => ({ createUsage: () => ({ trackCodexTurn: async f => f(), trackImage: async f => f(), trackExaSearch: async f => f(), inspectUsage: () => '' }) }))
        mock.module(${JSON.stringify(join(root, 'bot/moderation.ts'))}, () => ({ createModeration: () => ({ banned: async () => null }) }))
        mock.module(${JSON.stringify(join(root, 'bot/agent.ts'))}, () => ({ createAgent: () => ({ run: async () => '' }) }))
        mock.module(${JSON.stringify(join(root, 'bot/source.ts'))}, () => ({ createSource: () => ({ list: () => [], read: () => '' }) }))
        mock.module(${JSON.stringify(join(root, 'bot/monkeypatch.ts'))}, () => ({ createMonkeypatch: () => ({ run: async () => '', isOwner: () => false }), isOwner: () => false }))
        mock.module(${JSON.stringify(join(root, 'bot/image-generation.ts'))}, () => ({ createImageGeneration: () => ({ run: async () => '' }) }))
        const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const directory = mkdtempSync(join(tmpdir(), 'memory-permissions-'))
        writeFileSync(join(directory, 'db.json'), JSON.stringify({ config: {}, facts: { [memberId]: ['member fact'], [otherId]: ['other fact'], [botId]: ['bot fact'] } }))
        const { createInstance } = await import(${JSON.stringify(join(root, 'bot/instance.ts'))})
        const instance = createInstance({ name: 'clod', directory, allowProcessEnv: false })
        const slash = async (name, actorId, targetId, number = 1) => commands.get(name).handler(
            { next: { id: actorId }, interaction: { user: { id: actorId, bot: false } } },
            { user: { id: targetId }, number },
        )
        const tool = async (name, actorId, args) => {
            const entry = tools.get(name)
            const context = { next: { id: actorId }, message: { author: { id: actorId, bot: false }, webhookId: null } }
            return { available: entry.available(context), output: await entry.handler(args, context) }
        }
        const facts = () => JSON.parse(readFileSync(join(directory, 'db.json'), 'utf8')).facts
        const results = {}
        results.deleteOther = await slash('memories delete', memberId, otherId)
        results.afterDeleteOther = facts()
        results.deleteSelf = await slash('memories delete', memberId, memberId)
        results.nukeBot = await slash('memories nuke user', memberId, botId)
        results.afterNukeBot = facts()
        results.nukeAll = await slash('memories nuke all', memberId)
        results.afterNukeAll = facts()
        results.toolDeleteOther = await tool('delete-memory', memberId, { userId: otherId, number: 1 })
        results.toolDeleteFunFactOther = await tool('delete-fun-fact', memberId, { userId: otherId, fact: 'other fact' })
        results.toolNukeOther = await tool('nuke-user-memories', memberId, { userId: otherId })
        results.toolNukeBot = await tool('nuke-user-memories', memberId, { userId: botId })
        results.toolNukeAllMember = await tool('nuke-all-memories', memberId, {})
        results.afterToolRefusals = facts()
        results.toolDeleteOwner = await tool('delete-memory', ownerId, { userId: otherId, number: 1 })
        results.toolNukeBotOwner = await tool('nuke-user-memories', ownerId, { userId: botId })
        results.ownerNukeAll = await tool('nuke-all-memories', ownerId, {})
        console.log(JSON.stringify({ results, facts: facts() }))
        rmSync(directory, { recursive: true, force: true })
    `
    const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', timeout: 15000 })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
    const { results, facts } = JSON.parse(result.stdout)
    expect(results.deleteOther).toEqual({ content: expect.any(String), ephemeral: true })
    expect(results.afterDeleteOther[ '345678901234567890' ]).toEqual(['other fact'])
    expect(results.deleteSelf).toContain('deleted memory 1')
    expect(results.nukeBot.ephemeral).toBe(true)
    expect(results.afterNukeBot['1569837392070836224']).toEqual(['bot fact'])
    expect(results.nukeAll.ephemeral).toBe(true)
    expect(results.afterNukeAll['345678901234567890']).toEqual(['other fact'])
    expect(results.toolDeleteOther.output).toContain('only the owner')
    expect(results.toolDeleteFunFactOther.output).toContain('only the owner')
    expect(results.toolNukeOther.output).toContain('only the owner')
    expect(results.toolNukeBot.output).toContain('only the owner')
    expect(results.toolNukeAllMember.available).toBe(false)
    expect(results.afterToolRefusals['345678901234567890']).toEqual(['other fact'])
    expect(results.toolDeleteOwner.output).toContain('deleted memory 1')
    expect(results.toolNukeBotOwner.output).toContain('cleared memories')
    expect(results.ownerNukeAll.available).toBe(true)
    expect(results.ownerNukeAll.output).toBe('cleared all memories')
    expect(facts).toEqual({})
})
