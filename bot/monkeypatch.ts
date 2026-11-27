import { codingAgent, type Config } from './config.ts'
import { Codex } from '@openai/codex-sdk'
import type { Chats } from './bot.ts'
import { messageInitiator } from './initiator.ts'
import type { Usage } from './usage.ts'

export const ownerIds = ['143771295832735745', '285512995541483520']

export const isOwner = (context: Chats) => {
    const sender = context.message?.author ?? context.interaction?.user
    return sender != null && ownerIds.includes(sender.id) && !sender.bot && !context.message?.webhookId
}

export type Effort = 'medium' | 'high'

export type Monkeypatch = {
    isOwner: typeof isOwner,
    run: (task: string, context: Chats, effort?: Effort) => Promise<string>,
}

export const createMonkeypatch = ({ root, track, config }: { root: string, track: Usage['trackCodexTurn'], config: Config }): Monkeypatch => {
    let running = false

    const run = async (task: string, context: Chats, effort: Effort = codingAgent.effort) => {
        if (!isOwner(context)) return 'only the owner can use monkeypatch'
        // The Codex SDK uses the ChatGPT sign-in; running it in api mode would log that sign-in out.
        if (config.backend === 'api') return 'monkeypatch needs the codex backend because its Codex SDK uses the ChatGPT sign-in'
        if (running) return 'a monkeypatch is already running'
        running = true
        try {
            const { model } = codingAgent
            const codex = new Codex({ codexPathOverride: process.env.CODEX_BIN, config: { forced_login_method: 'chatgpt' } })
            const thread = codex.startThread({
                model, modelReasoningEffort: effort,
                workingDirectory: root, skipGitRepoCheck: true,
                sandboxMode: 'workspace-write', networkAccessEnabled: true, approvalPolicy: 'never',
            })
            const result = await track(model, effort, () => thread.run(`Edit clod's code to complete this task. Test the change. Monkeypatch must remain owner-only; persona tools must remain public. Do not restart clod; it will restart after your response if the task and tests succeeded. Keep your final response brief and do not disclose secrets.\n\nTask: ${task}`, {
                outputSchema: {
                    type: 'object', properties: { completed: { type: 'boolean' }, summary: { type: 'string' } },
                    required: ['completed', 'summary'], additionalProperties: false,
                },
            }), () => thread.id, messageInitiator(context))
            const { completed, summary } = JSON.parse(result.finalResponse)
            if (completed) context.restart = true
            return summary
        } catch (error) {
            console.error('monkeypatch failed')
            return `monkeypatch failed: ${error instanceof Error ? error.message : String(error)}`
        } finally {
            if (!context.restart) running = false
        }
    }

    return { isOwner, run }
}
