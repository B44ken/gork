import { readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { resolve } from 'path'

export type Source = { list: () => string[], read: (path: string) => string }

export const createSource = (root: string): Source => {
    const list = () => ['README.md', 'package.json', ...['bot', 'site', 'tests'].flatMap(dir => readdirSync(resolve(root, dir), { recursive: true, encoding: 'utf8' })
        .filter(path => /\.(?:tsx?|js|html|css)$/.test(path) && statSync(resolve(root, dir, path)).isFile())
        .map(path => `${dir}/${path}`))]

    const read = (path: string) => {
        if (!list().includes(path)) return `source file not found: ${path}`
        const file = resolve(root, path)
        if (realpathSync(file) !== file) return `source file not found: ${path}`
        return readFileSync(file, 'utf8')
    }

    return { list, read }
}
