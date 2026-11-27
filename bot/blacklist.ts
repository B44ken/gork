import { Database } from 'bun:sqlite'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'

export type Blacklist = {
    has: (userId: string) => boolean,
    status: (userId: string) => string | null,
    timeout: (userId: string, reason: string) => string,
    add: (userId: string) => string,
    remove: (userId: string) => string,
    userIds: () => string[],
    list: () => string,
    activeTimeouts: () => { userId: string, expiresAt: number, reason: string }[],
    clearTimeout: (userId: string) => string,
}

export const createBlacklist = (directory: string, config: Config): Blacklist => {
    const file = join(directory, 'blacklist.sqlite')
    const db = new Database(file, { create: true })
    chmodSync(file, 0o600)
    db.exec('CREATE TABLE IF NOT EXISTS blacklist (user_id TEXT PRIMARY KEY)')
    db.exec('CREATE TABLE IF NOT EXISTS timeouts (user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)')
    if (!(db.query('PRAGMA table_info(timeouts)').all() as { name: string }[]).some(column => column.name === 'reason')) {
        db.exec("ALTER TABLE timeouts ADD COLUMN reason TEXT NOT NULL DEFAULT 'reason unavailable'")
    }

    const has = (userId: string) => db.query('SELECT 1 FROM blacklist WHERE user_id = ?').get(userId) !== null
    const status = (userId: string) => {
        if (has(userId)) return 'user is blacklisted (reason: added by owner)'
        const row = db.query('SELECT expires_at, reason FROM timeouts WHERE user_id = ?').get(userId) as { expires_at: number, reason: string } | null
        const seconds = Math.ceil(((row?.expires_at ?? 0) - Date.now()) / 1000)
        if (seconds <= 0) return null
        const minutes = Math.floor(seconds / 60), remainder = seconds % 60
        return `user is blacklisted for ${minutes ? `${minutes} min${remainder ? ` ${remainder}s` : ''}` : `${remainder}s`} (reason: ${row!.reason})`
    }
    const timeout = (userId: string, reason: string) => {
        db.query('INSERT INTO timeouts (user_id, expires_at, reason) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, reason = excluded.reason').run(userId, Date.now() + config.moderation.timeout_seconds * 1000, reason)
        return status(userId)!
    }
    const add = (userId: string) => {
        db.query('INSERT INTO blacklist (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING').run(userId)
        return 'user is blacklisted'
    }
    const remove = (userId: string) => {
        db.query('DELETE FROM blacklist WHERE user_id = ?').run(userId)
        db.query('DELETE FROM timeouts WHERE user_id = ?').run(userId)
        return 'user is no longer blacklisted'
    }
    const userIds = () => (db.query('SELECT user_id FROM blacklist ORDER BY user_id').all() as { user_id: string }[]).map(row => row.user_id)
    const list = () => userIds().join('\n') || 'blacklist is empty'

    const activeTimeouts = () => db.query('SELECT user_id AS userId, expires_at AS expiresAt, reason FROM timeouts WHERE expires_at > ? ORDER BY expires_at').all(Date.now()) as { userId: string, expiresAt: number, reason: string }[]
    const clearTimeout = (userId: string) => {
        db.query('DELETE FROM timeouts WHERE user_id = ?').run(userId)
        return 'timeout cleared'
    }

    return { has, status, timeout, add, remove, userIds, list, activeTimeouts, clearTimeout }
}
