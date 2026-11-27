import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'node:path'

export const maxLength = 1800

export type Persona = {
    view: (name: string) => string,
    render: (name: string, values: { limit: number, facts: string }) => string,
    set: (content: string) => string,
    reset: () => string,
    maxLength: number,
}

export const createPersona = (directory: string): Persona => {
    const file = join(directory, 'persona.json')

    const view = (name: string): string => existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8')).prompt
        : `you are ${name}, a helpful, somewhat brainrotted, assistant.\nyour messages must be brief.`

    // The persona is the whole system prompt; dynamic values are substituted here.
    const render = (name: string, values: { limit: number, facts: string }): string =>
        `${view(name).replaceAll('{limit}', String(values.limit)).replaceAll('{facts}', values.facts)}\n\nlimit each text reply to ${values.limit} characters.`

    const set = (content: string): string => {
        const prompt = content.trim()
        if (!prompt || prompt.length > maxLength) return `persona must be between 1 and ${maxLength} characters`

        const temp = `${file}.${randomUUID()}.tmp`
        try {
            writeFileSync(temp, JSON.stringify({ prompt }, null, 4), { flag: 'wx', mode: 0o600 })
            renameSync(temp, file)
        } finally {
            if (existsSync(temp)) unlinkSync(temp)
        }
        return 'persona updated; it will apply to subsequent requests'
    }

    const reset = (): string => {
        if (existsSync(file)) unlinkSync(file)
        return 'persona reset; it will apply to subsequent requests'
    }

    return { view, render, set, reset, maxLength }
}
