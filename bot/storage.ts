import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'fs'
import { join, isAbsolute } from 'path'
import { randomBytes } from 'crypto'

const defaultRoot = () => {
    // 1. Explicit environment variable
    const envDir = process.env.GORK_DATA_DIR?.trim()
    if (envDir) return isAbsolute(envDir) ? envDir : join(process.cwd(), envDir)
    
    // 2. Standard persistent volume mount point
    if (existsSync('/data')) return '/data'
    
    // 3. Fallback to local 'data' directory in the project root
    return join(process.cwd(), 'persistence')
}

let memoizedRoot: string | null = null

export const storageRoot = () => {
    if (memoizedRoot) return memoizedRoot
    
    const root = defaultRoot()
    if (!existsSync(root)) {
        try {
            mkdirSync(root, { recursive: true })
        } catch (e) {
            console.error(`CRITICAL: Failed to create storage directory ${root}:`, e)
            // Last resort fallback
            memoizedRoot = join(process.cwd(), 'persistence')
            if (!existsSync(memoizedRoot)) mkdirSync(memoizedRoot, { recursive: true })
            return memoizedRoot
        }
    }
    
    memoizedRoot = root
    return root
}

export const storagePath = (...parts: string[]) => join(storageRoot(), ...parts)

/**
 * Migration helper: If a file exists in the legacy (repo) location but not in the
 * persistent storageRoot, move it to the storageRoot.
 */
export const migrateFromLegacy = (filename: string) => {
    const legacyPath = join(process.cwd(), filename)
    const newPath = storagePath(filename)
    
    if (legacyPath === newPath) return // Already the same
    
    if (existsSync(legacyPath) && !existsSync(newPath)) {
        console.log(`Migrating legacy file ${filename} to ${newPath}`)
        try {
            copyFileSync(legacyPath, newPath)
            // We keep the old file for safety during this transition
            // unlinkSync(legacyPath) 
        } catch (e) {
            console.error(`Failed to migrate ${filename}:`, e)
        }
    }
}

export const atomicWriteText = (path: string, text: string) => {
    const tmpPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
    try {
        writeFileSync(tmpPath, text, 'utf-8')
        renameSync(tmpPath, path)
    } catch (e) {
        console.error(`Failed atomic write to ${path}:`, e)
        throw e
    }
}

export const atomicWriteJson = (path: string, data: unknown, indent = 2) => {
    atomicWriteText(path, JSON.stringify(data, null, indent))
}
