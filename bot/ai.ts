import type { Config } from './config.ts'
import type { ChatLine, Chats } from './bot.ts'
import { messageInitiator } from './initiator.ts'
import { run, type Input, type Tool } from './codex.ts'
import type { Usage } from './usage.ts'

type ToolHandler = (args: any, context: Chats) => any
type Availability = (context: Chats) => boolean

export type AI = {
    tool: (name: string, desc: string, params: string[] | Record<string, object>, func: ToolHandler, available?: Availability, unavailableMessage?: string) => void,
    get: (context: Chats, ...msgs: (string | ChatLine | ChatLine[])[]) => Promise<string>,
}

export const createAI = ({ config, track }: { config: Config, track: Usage['trackCodexTurn'] }): AI => {
    const tools = new Map<string, Tool & { available: Availability, handler: ToolHandler, unavailableMessage: string }>()

    const tool = (name: string, desc: string, params: string[] | Record<string, object>, func: ToolHandler, available: Availability = () => true, unavailableMessage = 'tool unavailable for this sender; only the owner can use owner-only tools') => {
        const properties = Array.isArray(params) ? Object.fromEntries(params.map(p => [p, { type: 'string' }])) : params
        tools.set(name, {
            name, description: desc,
            parameters: {
                type: 'object', properties,
                required: Object.keys(properties), additionalProperties: false,
            },
            available, handler: func, unavailableMessage,
        })
    }

    const get = async (context: Chats, ...msgs: (string | ChatLine | ChatLine[])[]): Promise<string> => {
        const lines = msgs.flat().filter(a => typeof a !== 'string')
        const text = lines.map(a => `${a.name} (id: ${a.id}${a.messageId ? `, message id: ${a.messageId}` : ''}): ${a.msg}`).join('\n')
        const reply = context.reply
            ? `the last message replies to this one (message id: ${context.reply.messageId}, by ${context.reply.author}): ${context.reply.content}\n`
            : ''
        const input: Input[] = [{ type: 'text', text: reply + text }]
        for (const { source, urls } of context.images ?? []) {
            input.push({ type: 'text', text: `images attached to ${source}:` }, ...urls.map(url => ({ type: 'image' as const, url })))
        }
        for (const { source, name, text } of context.textFiles ?? []) {
            input.push({ type: 'text', text: `text file ${JSON.stringify(name)} attached to ${source}:\n${text}` })
        }
        const result = await run({
            source: 'chat', model: config.model, effort: config.thinking, backend: config.backend, claudeModel: config.claude_model,
            instructions: msgs[0] as string, input, initiator: messageInitiator(context), track,
            tools: [...tools.values()].filter(tool => tool.available(context)).map(({ available, handler, unavailableMessage, ...tool }) => tool),
            callTool: async (name, args) => {
                const tool = tools.get(name)
                if (!tool?.available(context)) return tool?.unavailableMessage ?? 'tool unavailable for this sender; only the owner can use owner-only tools'
                const output = await tool.handler(args, context)
                console.log(`${name}: finished`)
                return output
            },
        })
        return result.finalResponse
    }

    return { tool, get }
}
