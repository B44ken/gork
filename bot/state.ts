import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, type Config } from './config.ts'

export type State = { config: Config, facts: Record<string, string[]> }

export type StateStore = { read: () => State, update: (update: (state: State) => void) => void }

export const createState = (directory: string): StateStore => {
    const file = join(directory, 'db.json')
    const read = (): State => existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8'))
        : { config: structuredClone(defaultConfig), facts: {} }
    return {
        read,
        update(update) {
            const state = read()
            update(state)
            writeFileSync(file, JSON.stringify(state, null, 4))
        },
    }
}
