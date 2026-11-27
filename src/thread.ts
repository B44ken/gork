// The central agent thread: one long-lived Agent SDK session per instance. Discord events are pushed in
// as user messages; the agent's only tool is `bash` over its workspace, and plain-text output goes nowhere.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { kernel as Kernel } from './kernel.ts'

const system = `You are a Discord bot that lives in a workspace. Discord events arrive as user messages starting with [event].
Nobody ever sees your plain-text output: you act only by running commands with the bash tool, and you talk to Discord only through those commands.
At the start of a session, run \`cat /AGENTS.md /SOUL.md\` and follow them. They, and everything under /memory and /bin, are yours to edit.`

export default (instance: any, kernel: typeof Kernel) => {
    const sessionFile = join(instance.dir, 'session-id')
    const queue: SDKUserMessage[] = []
    let wake = () => {}, closed = false

    const thread = {
        busy: false,
        sessionId: existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim() : undefined as string | undefined,
        // ponytail: in-memory live tail for the dashboard; history comes from the session transcript on disk.
        live: [] as unknown[],
        push(text: string) {
            queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
            wake()
        },
        close() { closed = true; wake() },
    }

    async function* input() {
        while (!closed) {
            const next = queue.shift()
            if (next) { thread.busy = true; yield next }
            else await new Promise<void>(resolve => wake = resolve)
        }
    }

    const bash = tool('bash', 'Run a bash command in your workspace (a virtual shell: /memory, /bin, /chat, /src, /tmp). Returns stdout, stderr and the exit code.',
        { command: z.string() },
        async ({ command }) => (await kernel.load('shell.ts'))(command, instance, kernel))

    const run = async () => {
        for await (const message of query({
            prompt: input(),
            options: {
                cwd: instance.workspace,
                model: instance.env.MODEL ?? 'claude-opus-5-5',
                effort: (instance.env.EFFORT ?? 'low') as 'low',
                thinking: { type: 'adaptive', display: 'summarized' },
                systemPrompt: system,
                tools: [],
                mcpServers: { gork: createSdkMcpServer({ name: 'gork', tools: [bash] }) },
                allowedTools: ['mcp__gork__bash'],
                permissionMode: 'dontAsk',
                settingSources: [],
                strictMcpConfig: true,
                settings: { disableClaudeAiConnectors: true },
                env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
                pathToClaudeCodeExecutable: process.env.CLAUDE_BIN,
                ...(thread.sessionId ? { resume: thread.sessionId } : {}),
            },
        })) {
            thread.live.push(message)
            if (thread.live.length > 500) thread.live.splice(0, 100)
            if (message.session_id && message.session_id !== thread.sessionId) {
                thread.sessionId = message.session_id
                writeFileSync(sessionFile, message.session_id)
            }
            if (message.type === 'result') {
                thread.busy = queue.length > 0
                if (message.subtype !== 'success') kernel.report(new Error(`turn ended: ${message.subtype}`), 'thread.ts')
                // A deploy during this turn left this thread stale; swap it now that it is idle.
                if (instance.threadVersion !== kernel.state.version) kernel.reconcile()
            }
        }
    }
    run().catch(error => {
        thread.busy = false
        kernel.report(error, 'thread.ts')
    })
    return thread
}
