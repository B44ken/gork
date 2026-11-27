import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dashboard } from './config.ts'
import { createInstance, type Instance, type InstanceOptions } from './instance.ts'
import { startDashboard } from '../site/main.ts'

const entriesOf = (file: string): unknown => {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : parsed?.instances
}

export const loadInstances = (file = process.env.GORK_INSTANCES ?? join(process.cwd(), 'instances.json')): InstanceOptions[] => {
    const path = resolve(file)
    if (!existsSync(path)) return [{ name: 'gork', directory: process.cwd(), allowProcessEnv: true }]
    const entries = entriesOf(path)
    if (!Array.isArray(entries) || !entries.length) throw new Error(`${path} must contain a non-empty "instances" array`)
    const names = new Set<string>(), directories = new Set<string>()
    return entries.map((entry, index) => {
        if (!entry || typeof entry !== 'object') throw new Error(`instance ${index + 1} in ${path} must be an object`)
        const record = entry as Record<string, unknown>
        if (typeof record.directory !== 'string' || !record.directory.trim()) throw new Error(`instance ${index + 1} in ${path} needs a directory`)
        const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : `gork-${index + 1}`
        const directory = resolve(dirname(path), record.directory)
        if (names.has(name)) throw new Error(`duplicate instance name in ${path}: ${name}`)
        if (directories.has(directory)) throw new Error(`duplicate instance directory in ${path}: ${directory}`)
        names.add(name); directories.add(directory)
        return {
            name, directory,
            // A shared DISCORD_TOKEN would log the same bot in twice, so only a single instance may fall back to the process environment.
            allowProcessEnv: entries.length === 1,
            ...(typeof record.envFile === 'string' ? { envFile: record.envFile } : {}),
            ...(typeof record.token === 'string' ? { token: record.token } : {}),
            ...(typeof record.exaApiKey === 'string' ? { exaApiKey: record.exaApiKey } : {}),
        }
    })
}

export const start = (file?: string): Instance[] => {
    const instances = loadInstances(file).map(createInstance)
    for (const instance of instances) {
        try {
            instance.start()
        } catch (error) {
            console.error(`instance ${instance.name} failed to start: ${error instanceof Error ? error.message : String(error)}`)
            void instance.stop()
        }
    }
    // Every instance shares one dashboard and one port, mounted under its own name.
    const server = startDashboard(instances.map(instance => ({ name: instance.name, context: instance.dashboard.context, users: instance.dashboard.users })),
        Number(process.env.GORK_PORT ?? dashboard.port))
    console.log(`dashboard on http://localhost:${server.port}/`)
    process.on('SIGINT', () => void shutdown(instances, server))
    process.on('SIGTERM', () => void shutdown(instances, server))
    return instances
}

const shutdown = async (instances: Instance[], server: ReturnType<typeof startDashboard>) => {
    server.stop(true)
    await Promise.all(instances.map(instance => instance.stop().catch(() => {})))
    process.exit(0)
}

if (import.meta.main) start()
