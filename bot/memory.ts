import { existsSync, readFileSync, writeFileSync } from 'fs'
import { config } from '../db.json'
type Memory = { facts: Record<string, string[]> }

if(!existsSync('db.json')) writeFileSync('db.json', '{}')
export const load = (): Memory => JSON.parse(readFileSync('db.json', 'utf-8'))
export const save = (mem: Memory) => writeFileSync('db.json', JSON.stringify(mem, null, 4))

export const addFact = ({ user, fact }: { user: string, fact: string }) => {
    const m: Memory = load()
    if (!m.facts[user]) m.facts[user] = []
    m.facts[user] = [...new Set([...m.facts[user], fact])]
    save(m)
}

export const deleteFact = ({ user, fact }: { user: string, fact: string }) => {
    const m: Memory = load()
    if (!m.facts[user]) return
    m.facts[user] = m.facts[user].filter(f => f != fact)
    save(m)
}

export const buildFacts = (...users: string[]) => 
    Object.entries(load().facts)
        .filter(([k]) => users.includes(k))
        .map(([k, facts]) => `${k}:\n${facts.map(f => ` - ${f}`).join('\n')}`)
        .join('\n')

export const setConfig = ({ key, value }: { key: string, value: string }) => {
    if (key == 'context') {
        const v = Number(value)
        if (!Number.isInteger(v) || v < 1) return 'context must be an integer >= 1'
        config.context = v
    } else if (key == 'thinking') {
        if (value != 'none' && value != 'low') return 'thinking must be one of: none, low'
        config.thinking = value
    } else if (key == 'waffle.chance') {
        const v = Number(value)
        if (Number.isNaN(v) || v < 0 || v > 1) return 'waffle.chance must be a number between 0 and 1'
        config.waffle.chance = v
    } else if (key == 'waffle.after_msgs') {
        const v = Number(value)
        if (!Number.isInteger(v) || v < 0) return 'waffle.after_msgs must be an integer >= 0'
        config.waffle.after_msgs = v
    } else {
        return 'unknown key. use one of: context, thinking, waffle.chance, waffle.after_msgs'
    }

    const db = JSON.parse(readFileSync('db.json', 'utf-8'))
    db.config = config
    writeFileSync('db.json', JSON.stringify(db, null, 4))
    return `set config.${key}=${value}`
}