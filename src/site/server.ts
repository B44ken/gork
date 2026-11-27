// Read-only trace dashboard: each instance's agent session as events, thinking summaries, commands and output.
// It reads the transcript the Agent SDK already writes, so nothing extra is stored.
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { kernel as Kernel } from '../kernel.ts'

type Entry = { kind: 'event' | 'thinking' | 'text' | 'command' | 'output', text: string }

const blocks = (content: unknown): any[] => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
const plain = (content: unknown) => blocks(content).map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').join('\n')

export const entries = (messages: { type: string, message: unknown }[]): Entry[] => messages.flatMap(({ type, message }) =>
    blocks((message as any)?.content).flatMap((block): Entry[] => {
        if (type === 'user' && block.type === 'text') return [{ kind: 'event', text: block.text }]
        if (block.type === 'tool_result') return [{ kind: 'output', text: plain(block.content) }]
        if (block.type === 'thinking' && block.thinking) return [{ kind: 'thinking', text: block.thinking }]
        if (block.type === 'text' && block.text) return [{ kind: 'text', text: block.text }]
        if (block.type === 'tool_use') return [{ kind: 'command', text: block.input?.command ?? JSON.stringify(block.input) }]
        return []
    }))

const page = (name: string) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${name} trace</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--dim:#6e6e73;--line:#e5e5ea;--event:#0a5;--cmd:#05c}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--dim:#999;--line:#2a2a2a;--event:#4c8;--cmd:#6af}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,Menlo,monospace;margin:0 auto;max-width:960px;padding:16px}
h1{font:600 18px system-ui;margin:0 0 12px}
.e{white-space:pre-wrap;word-break:break-word;border-left:3px solid var(--line);padding:4px 10px;margin:6px 0}
.event{border-color:var(--event)}.command{border-color:var(--cmd);color:var(--cmd)}.command::before{content:"$ "}
.thinking{color:var(--dim);font-style:italic}.output{color:var(--dim);max-height:16em;overflow:auto}.text{color:var(--dim)}
</style>
<h1>${name} · agent trace</h1><div id=log></div>
<script>
const log = document.getElementById('log')
let count = 0
async function poll() {
  const entries = await fetch('trace.json').then(r => r.json()).catch(() => null)
  if (entries && entries.length !== count) {
    const stick = innerHeight + scrollY >= document.body.scrollHeight - 40
    log.replaceChildren(...entries.map(e => Object.assign(document.createElement('div'), { className: 'e ' + e.kind, textContent: e.text })))
    count = entries.length
    if (stick) scrollTo(0, document.body.scrollHeight)
  }
  setTimeout(poll, 3000)
}
poll()
</script>`

export default async (request: Request, state: any, kernel: typeof Kernel) => {
    const [name, file] = new URL(request.url).pathname.split('/').filter(Boolean)
    const instance = name && state.instances[name]
    if (!name) return new Response(Object.keys(state.instances).map(n => `<p><a href="/${n}/">${n}</a>`).join('') || 'no instances',
        { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (!instance) return new Response('not found', { status: 404 })
    if (file === 'dm-probe.json') {
        // Temporary: replay a DM packet authored by the bot itself (the hook ignores own messages).
        const client = instance.client
        const id = String((BigInt(Date.now() - 1420070400000) << 22n))
        let emitted = false
        const listener = (m: any) => { if (m.id === id) emitted = true }
        client.on('messageCreate', listener)
        let error: string | null = null
        try {
            client.actions.MessageCreate.handle({ id, channel_id: '1575671201362223155', type: 0, content: 'probe', timestamp: new Date().toISOString(),
                author: { id: client.user.id, username: client.user.username, discriminator: '0', avatar: null }, attachments: [], embeds: [], mentions: [], mention_roles: [], pinned: false, tts: false, mention_everyone: false })
        } catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e) }
        await new Promise(resolve => setTimeout(resolve, 200))
        client.off('messageCreate', listener)
        return Response.json({ emitted, error, dmCached: client.channels.cache.filter((c: any) => c.isDMBased()).map((c: any) => c.id) })
    }
    if (file === 'debug.json') {
        const client = instance.client
        return Response.json({ intents: client.options.intents.bitfield, partials: client.options.partials, listeners: client.listenerCount('messageCreate'),
            ready: client.isReady(), ws: client.ws.status, dmCached: client.channels.cache.filter((c: any) => c.isDMBased()).map((c: any) => c.id) })
    }
    if (!file) {
        if (!new URL(request.url).pathname.endsWith('/')) return Response.redirect(`/${name}/`, 302)
        return new Response(page(name), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (file !== 'trace.json') return new Response('not found', { status: 404 })
    const id = instance.thread?.sessionId
    const messages = id ? await getSessionMessages(id, { dir: instance.workspace }) : []
    return Response.json(entries(messages).slice(-400))
}
