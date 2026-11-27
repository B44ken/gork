import { codingAgent, type Config } from './config.ts'
import { run as runCodex } from './codex.ts'
import type { Source } from './source.ts'
import type { Initiator } from './initiator.ts'
import type { Usage } from './usage.ts'

export type Agent = { run: (task: string, initiator?: Initiator | null) => Promise<string> }

export const createAgent = ({ source, track, config }: { source: Source, track: Usage['trackCodexTurn'], config: Config }): Agent => ({
    run: async (task: string, initiator?: Initiator | null): Promise<string> => {
        const result = await runCodex({
            source: 'agent', ...codingAgent, backend: config.backend, claudeModel: config.claude_model, initiator, track,
            instructions: 'You are a coding agent investigating the bot. Use the available source tools to answer the task. You cannot modify files or run commands. Be concise.',
            input: [{ type: 'text', text: task }],
            tools: [
                { name: 'list-source', description: 'list bot source files', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
                { name: 'read-source', description: 'read a file from list-source', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
            ],
            callTool: async (name, args) => {
                if (name === 'list-source') return source.list()
                if (name === 'read-source') return source.read(args.path)
                throw new Error(`unknown agent tool: ${name}`)
            },
        })
        return result.finalResponse
    },
})
