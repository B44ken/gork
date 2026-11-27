import { runInNewContext } from 'node:vm'
import { types } from 'node:util'
import type { Client } from 'discord.js'

const sensitive = /token|secret|password|credential|authorization|cookie|api.?key|private.?key/i
const limit = 6000

export const secrets = (client: Client) => [
    ...Object.entries(process.env).filter(([key, value]) => value && (sensitive.test(key) || value.length >= 8)).map(([, value]) => value!),
    client.token,
].filter((value): value is string => Boolean(value))

const redact = (text: string, values: string[]) => {
    for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
        for (const form of [value, JSON.stringify(value).slice(1, -1)]) text = text.replaceAll(form, '[redacted]')
    }
    const suffix = '… [truncated]'
    return text.length > limit ? text.slice(0, limit - suffix.length) + suffix : text
}

export const run = async (code: string, client: Client): Promise<string> => {
    const values = secrets(client)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const result = await Promise.race([
            runInNewContext(`(async () => {\n${code}\n})()`, { client }, { timeout: 1000 }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('execution timed out')), 5000) }),
        ])
        const seen = new WeakSet<object>()
        const output = JSON.stringify(result, (key, value) => {
            if (sensitive.test(key)) return '[redacted]'
            if (typeof value === 'bigint') return value.toString()
            if (types.isNativeError(value)) return { name: value.name, message: value.message }
            if (value && typeof value === 'object') {
                if (seen.has(value)) return '[circular]'
                seen.add(value)
                if (types.isMap(value)) return Array.from(value.entries().take(50))
                if (Array.isArray(value) && value.length > 50) return value.slice(0, 50)
            }
            return value
        }) ?? 'undefined'
        return redact(output, [...values, ...secrets(client)])
    } catch (error) {
        return redact(`error: ${error instanceof Error ? error.message : String(error)}`, [...values, ...secrets(client)])
    } finally {
        clearTimeout(timer)
    }
}
