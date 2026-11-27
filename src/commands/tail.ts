// tail and head of /chat/channel/<id>.md fetch exactly the messages asked for; other files use the builtins.
import { Bash, defineCommand, type CommandContext as Ctx } from 'just-bash'
import { fetchEnd, maxFetch, render } from '../fs/chat.ts'
import type { CommandContext } from '../shell.ts'

const builtins = (new Bash() as any).commands
const builtin = (name: string) => builtins.get ? builtins.get(name) : builtins[name]

export const channelEnd = (name: 'tail' | 'head', end: 'last' | 'first') => ({ chat }: CommandContext) => defineCommand(name, async (args, ctx: Ctx) => {
    const file = args.map(arg => ctx.fs.resolvePath(ctx.cwd, arg)).find(path => /^\/chat\/channel\/\d+\.md$/.test(path))
    if (!file) return builtin(name).execute(args, ctx)
    const flag = args.findIndex(arg => arg === '-n')
    const count = flag >= 0 ? Number(args[flag + 1]) : Number(args.find(arg => /^-\d+$/.test(arg))?.slice(1) ?? 10)
    if (!Number.isInteger(count) || count < 1) return { stdout: '', stderr: `${name}: invalid line count\n`, exitCode: 2 }
    const channel = file.match(/(\d+)\.md$/)![1]
    const messages = await fetchEnd(chat.source, channel, Math.min(count, maxFetch), end)
    return { stdout: render(channel, messages) + (messages.length ? '\n' : ''), stderr: count > maxFetch ? `${name}: capped at ${maxFetch} messages\n` : '', exitCode: 0 }
})

export default channelEnd('tail', 'last')
