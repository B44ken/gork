import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'

const SESSION_FILE = 'dashboard-session-secret.txt'

const readSecretFile = () => {
    if (!existsSync(SESSION_FILE)) {
        writeFileSync(SESSION_FILE, randomBytes(32).toString('hex'))
    }
    return readFileSync(SESSION_FILE, 'utf-8').trim()
}

export const getSessionSecret = () =>
    process.env.DASHBOARD_SESSION_SECRET?.trim() || readSecretFile()
