import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

export type Scenario = {
    text?: string,
    tools?: { name: string, arguments: object }[],
    image?: string,
    error?: string,
}

export function serve(directory: string) {
    const queueFile = join(directory, 'scenarios.json')
    const queue: Scenario[] = JSON.parse(readFileSync(queueFile, 'utf8'))
    const scenario = queue.shift()!
    writeFileSync(queueFile, JSON.stringify(queue))
    const threadId = crypto.randomUUID()
    const log = (event: object) => appendFileSync(join(directory, 'events.jsonl'), JSON.stringify({ threadId, ...event }) + '\n')
    const send = (message: object) => process.stdout.write(JSON.stringify(message) + '\n')
    let toolIndex = 0
    const advance = () => {
        const tool = scenario.tools?.[toolIndex++]
        if (tool) {
            send({ id: 100 + toolIndex, method: 'item/tool/call', params: { tool: tool.name, arguments: tool.arguments } })
            return
        }
        if (scenario.error) {
            send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: scenario.error } } } })
            return
        }
        send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, reasoningOutputTokens: 5, cacheWriteInputTokens: 0 } } } })
        if (scenario.image) send({ method: 'item/completed', params: { item: { type: 'imageGeneration', status: 'completed', savedPath: scenario.image } } })
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: scenario.text ?? 'done' } } })
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    }
    createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line)
        log(message)
        if (message.method === 'initialize') send({ id: message.id, result: {} })
        if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: threadId } } })
        if (message.method === 'turn/start') {
            send({ id: message.id, result: {} })
            advance()
        }
        if (message.result && message.id >= 100) advance()
    })
}
