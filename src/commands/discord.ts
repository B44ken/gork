// discord <METHOD> <route> [json] [--file /path ...]: the whole Discord REST API, as the bot.
// The JSON body can also come from stdin. Output is the JSON response.
import { basename } from 'node:path'
import { decodeBytesToUtf8, defineCommand } from 'just-bash'
import type { RequestMethod, RouteLike } from 'discord.js'
import type { CommandContext } from '../shell.ts'

const usage = 'usage: discord <GET|POST|PATCH|PUT|DELETE> </route> [json] [--file /path ...]\n'

export default ({ instance }: CommandContext) => defineCommand('discord', async (args, ctx) => {
    const files: { name: string, data: Buffer }[] = []
    const rest: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--file') { rest.push(args[i]); continue }
        const path = ctx.fs.resolvePath(ctx.cwd, args[++i] ?? '')
        files.push({ name: basename(path), data: Buffer.from(await ctx.fs.readFileBuffer(path)) })
    }
    const [method, route, json = decodeBytesToUtf8(ctx.stdin).trim()] = rest
    if (!method || !route?.startsWith('/')) return { stdout: '', stderr: usage, exitCode: 2 }
    let body: unknown
    try { body = json ? JSON.parse(json) : undefined } catch { return { stdout: '', stderr: `body is not valid JSON\n${usage}`, exitCode: 2 } }
    try {
        const data = await instance.client.rest.request({
            method: method.toUpperCase() as RequestMethod, fullRoute: route as RouteLike, body, ...(files.length && { files }),
        })
        return { stdout: `${JSON.stringify(data ?? null)}\n`, stderr: '', exitCode: 0 }
    } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }
    }
})
