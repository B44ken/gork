// Reconciles what should be running (instances.json) with what is running. Safe to call repeatedly:
// it reuses live clients, threads and the http server, and only replaces what is missing or stale.
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import type { kernel as Kernel } from './kernel.ts'

type K = typeof Kernel

const parseEnv = (file: string) => Object.fromEntries(readFileSync(file, 'utf8').split('\n')
    .map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
        const index = line.indexOf('=')
        return [line.slice(0, index).trim().replace(/^export\s+/, ''), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]
    }))

export default async (state: any, kernel: K) => {
    const manifest = join(kernel.root, 'instances.json')
    const { instances } = JSON.parse(readFileSync(manifest, 'utf8')) as { instances: { name: string, directory: string }[] }

    for (const { name, directory } of instances) {
        const dir = resolve(kernel.root, directory)
        const instance = state.instances[name] ??= { name, dir, workspace: join(dir, 'workspace') }
        instance.env = parseEnv(join(dir, '.env.local'))
        if (!existsSync(instance.workspace)) cpSync(join(kernel.root, 'template'), instance.workspace, { recursive: true })

        if (!instance.client) {
            const client = new Client({
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
                partials: [Partials.Channel],
                allowedMentions: { parse: [], repliedUser: false },
            })
            // Listeners resolve the hook on every event, so hook edits apply to the next message.
            client.on('messageCreate', message => kernel.load('hooks/message.ts')
                .then(hook => hook(message, instance, kernel)).catch(error => kernel.report(error, 'hooks/message.ts')))
            client.once('clientReady', () => console.log(`${name}: connected as ${client.user!.tag}`))
            instance.client = client
            await client.login(instance.env.DISCORD_TOKEN)
        }

        // A thread built from older code is swapped out between turns; the session itself is resumed.
        if (instance.threadVersion !== state.version && !instance.thread?.busy) {
            instance.thread?.close()
            instance.thread = (await kernel.load('thread.ts'))(instance, kernel)
            instance.threadVersion = state.version
        }
    }

    const handler = await kernel.load('site/server.ts')
    const fetch = (request: Request) => handler(request, state, kernel)
    if (state.server) state.server.reload({ fetch })
    else {
        state.server = Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.GORK_PORT ?? 6769), fetch })
        console.log(`trace dashboard on http://localhost:${state.server.port}/`)
    }
}
