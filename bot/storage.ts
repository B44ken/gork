import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const defaultRoot = () => {
    const dataDir = process.env.GORK_DATA_DIR?.trim()
    if (dataDir) return dataDir
    return existsSync('/data') ? '/data' : process.cwd()
}

export const storageRoot = () => {
    const root = defaultRoot()
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    return root
}

export const storagePath = (...parts: string[]) => join(storageRoot(), ...parts)
