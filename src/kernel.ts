// The only cold file: it owns the process, the module loader, and deploys. Everything else in src/ is
// loaded through `load`, so it can change without a restart. Editing this file needs a process restart.
import { resolve } from 'node:path'

export const src = import.meta.dir
export const root = resolve(src, '..')
const self = resolve(src, 'kernel.ts')

// Live objects (discord clients, the agent thread, the http server) survive reloads here.
export const state: any = (globalThis as any).gork ??= { version: 0, instances: {} }

// ponytail: each deploy imports a fresh copy of src/ and the old copy stays in memory; fine while deploys are rare.
export const load = async (path: string) => (await import(`${src}/${path}?v=${state.version}`)).default

export const report = (error: unknown, where = 'kernel') => {
    const text = `[error] ${where}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`.slice(0, 4000)
    console.error(text)
    // The agent can read /src, so it hears about its own broken code.
    for (const instance of Object.values<any>(state.instances)) instance.thread?.push(text)
}

export const reconcile = () => load('boot.ts').then(boot => boot(state, kernel)).catch(error => report(error, 'boot.ts'))

const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    return { ok: (await proc.exited) === 0, out: out.trim() }
}

// Nothing reaches the live process unless it typechecks and the tests pass. Git is left to the humans.
let deploying: Promise<string> | undefined
const deploy = () => deploying ??= (async () => {
    try {
        for (const cmd of [['bunx', 'tsc', '-p', '.'], ['bun', 'test']]) {
            const result = await run(cmd)
            if (!result.ok) return `${cmd.join(' ')} failed, nothing deployed:\n${result.out.slice(-6000)}`
        }
        for (const key of Object.keys(require.cache)) if (key.startsWith(src) && key !== self) delete require.cache[key]
        state.version++
        await reconcile()
        return `deployed version ${state.version}`
    } finally {
        deploying = undefined
    }
})()

export const kernel = { src, root, state, load, report, reconcile, deploy }

if (import.meta.main) {
    process.on('unhandledRejection', error => report(error, 'unhandled rejection'))
    process.on('uncaughtException', error => report(error, 'uncaught exception'))
    process.on('SIGHUP', () => deploy().then(console.log))
    await reconcile()
}
