import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const defaultReplyLimit = 140
export const maximumReplyLimit = 1990

export type ReplyLimits = {
    forChannel: (channelId: string) => number,
    view: (channelId?: string) => string,
    set: (channelId: string, limit: number) => string,
    reset: (channelId: string) => string,
}

export const createReplyLimits = (directory: string): ReplyLimits => {
    const file = join(directory, 'reply-limits.json')
    const read = (): Record<string, number> => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    const write = (limits: Record<string, number>) => {
        const temp = `${file}.${randomUUID()}.tmp`
        try {
            writeFileSync(temp, JSON.stringify(limits, null, 4), { flag: 'wx', mode: 0o600 })
            renameSync(temp, file)
        } finally {
            if (existsSync(temp)) unlinkSync(temp)
        }
    }

    return {
        forChannel: channelId => read()[channelId] ?? defaultReplyLimit,
        view: channelId => channelId
            ? `channel ${channelId}: ${read()[channelId] ?? `${defaultReplyLimit} (default)`}`
            : `default: ${defaultReplyLimit}; overrides: ${JSON.stringify(read())}`,
        set(channelId, limit) {
            if (!channelId.trim()) return 'channel id is required'
            if (!Number.isInteger(limit) || limit < 1 || limit > maximumReplyLimit) return `limit must be an integer between 1 and ${maximumReplyLimit}`
            const limits = read()
            limits[channelId] = limit
            write(limits)
            return `set reply limit for channel ${channelId} to ${limit}`
        },
        reset(channelId) {
            const limits = read()
            delete limits[channelId]
            write(limits)
            return `reset reply limit for channel ${channelId} to default ${defaultReplyLimit}`
        },
    }
}
