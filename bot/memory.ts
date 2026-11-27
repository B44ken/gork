import type { StateStore } from './state.ts'

const idFor = (id: string) => {
    if (!/^\d{17,20}$/.test(id)) throw new Error('expected a discord user id')
    return id
}

export type MemoryUser = { id: string, username: string, displayName: string }

export type Memory = {
    load: StateStore['read'],
    save: (memory: { facts: Record<string, string[]> }) => void,
    addFact: (fact: { userId: string, fact: string }) => void,
    deleteFact: (fact: { userId: string, fact: string }) => void,
    listFacts: (userId: string) => string,
    deleteFactAt: (userId: string, number: number) => string,
    nukeFacts: (userId?: string) => string,
    buildFacts: (users: MemoryUser[]) => string,
}

export const createMemory = (store: StateStore): Memory => {
    const load = store.read
    const save = (memory: { facts: Record<string, string[]> }) => store.update(state => { state.facts = memory.facts })

    const addFact = ({ userId, fact }: { userId: string, fact: string }) => {
        userId = idFor(userId)
        const m = load()
        if (!m.facts[userId]) m.facts[userId] = []
        m.facts[userId] = [...new Set([...m.facts[userId], fact])]
        save(m)
    }

    const deleteFact = ({ userId, fact }: { userId: string, fact: string }) => {
        userId = idFor(userId)
        const m = load()
        if (!m.facts[userId]) return
        m.facts[userId] = m.facts[userId].filter(f => f != fact)
        save(m)
    }

    const listFacts = (userId: string) => {
        const facts = load().facts[idFor(userId)] || []
        return facts.length ? facts.map((fact, i) => `${i + 1}. ${fact}`).join('\n') : `no memories for ${userId}`
    }

    const deleteFactAt = (userId: string, number: number) => {
        const m = load()
        const facts = m.facts[idFor(userId)] || []
        if (!Number.isInteger(number) || number < 1 || number > facts.length) return `no memory ${number} for ${userId}`
        const [fact] = facts.splice(number - 1, 1)
        save(m)
        return `deleted memory ${number} for ${userId}: ${fact}`
    }

    const nukeFacts = (userId?: string) => {
        const m = load()
        if (userId !== undefined) delete m.facts[idFor(userId)]
        else m.facts = {}
        save(m)
        return userId !== undefined ? `cleared memories for ${userId}` : 'cleared all memories'
    }

    const buildFacts = (users: MemoryUser[]) => {
        const facts = load().facts
        return users
            .filter(user => facts[user.id]?.length)
            .map(user => `id: ${user.id}, username: ${user.username}, display name: ${user.displayName}:\n${facts[user.id].map(f => ` - ${f}`).join('\n')}`)
            .join('\n')
    }

    return { load, save, addFact, deleteFact, listFacts, deleteFactAt, nukeFacts, buildFacts }
}
