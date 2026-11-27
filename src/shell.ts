// The bash tool: a just-bash shell over the workspace (/), the bot's source (/src), Discord (/chat) and
// scratch space (/tmp). No real processes run; every command is either a just-bash builtin or src/commands/*.ts.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bash, InMemoryFs, MountableFs, ReadWriteFs, type CustomCommand, type IFileSystem } from 'just-bash'
import type { kernel as Kernel } from './kernel.ts'

export type Image = { data: string, mimeType: string }
// What every command factory in src/commands receives.
export type CommandContext = { instance: any, kernel: typeof Kernel, chat: { fs: unknown, source: import('./fs/chat.ts').Source }, images: Image[] }

const maxOutput = 30_000

export const createShell = ({ workspace, root, chat, commands, env }: {
    workspace: string, root: string, chat: { fs: unknown }, commands: CustomCommand[], env: Record<string, string>,
}) => new Bash({
    fs: new MountableFs({
        base: new ReadWriteFs({ root: workspace }),
        mounts: [
            { mountPoint: '/chat', filesystem: chat.fs as IFileSystem },
            { mountPoint: '/src', filesystem: new ReadWriteFs({ root }) },
            { mountPoint: '/tmp', filesystem: new InMemoryFs() },
        ],
    }),
    cwd: '/',
    env: { HOME: '/', PATH: '/bin:/usr/bin', ...env },
    customCommands: commands,
    // ponytail: off because every command is trusted host code (discord.js, fetch, Bun.spawn) that needs
    // timers, network and processes. js-exec runs in QuickJS and curl is GET-only below; python stays disabled.
    // Revisit if those are ever enabled.
    // curl/wget: GET/HEAD only, no private/LAN ranges, 10 MB cap. js-exec: sandboxed QuickJS.
    network: { dangerouslyAllowFullInternetAccess: true, allowedMethods: ['GET', 'HEAD'], denyPrivateRanges: true, maxResponseSize: 10 * 1024 * 1024, timeoutMs: 30_000 },
    javascript: true,
    defenseInDepth: false,
})

export const execute = async (bash: Bash, command: string) => {
    try {
        const result = await bash.exec(command)
        const out = `${result.stdout}${result.stderr}${result.exitCode ? `\n[exit ${result.exitCode}]` : ''}`
        return out.length > maxOutput ? `${out.slice(0, maxOutput)}\n[output truncated at ${maxOutput} characters]` : out || '[no output]'
    } catch (error) {
        // just-bash rejects instead of setting an exit code for some filesystem errors (e.g. writing into /chat).
        return `error: ${error instanceof Error ? error.message : String(error)}`
    }
}

export default async (command: string, instance: any, kernel: typeof Kernel) => {
    const images: Image[] = []
    const chat = (await kernel.load('fs/chat.ts'))(instance.client)
    const context: CommandContext = { instance, kernel, chat, images }
    const files = readdirSync(join(kernel.src, 'commands')).filter(file => file.endsWith('.ts'))
    const commands = await Promise.all(files.map(async file => (await kernel.load(`commands/${file}`))(context) as CustomCommand))
    const bash = createShell({ workspace: instance.workspace, root: kernel.root, chat, commands, env: instance.current ?? {} })
    const text = await execute(bash, command)
    return { content: [{ type: 'text' as const, text }, ...images.map(image => ({ type: 'image' as const, ...image }))] }
}
