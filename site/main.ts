import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { UserManager } from 'discord.js'
import { dashboard } from '../bot/config.ts'
import { dashboardState, dashboardUsage, type DashboardContext } from './state.ts'

export type DashboardClient = { name: string, context: DashboardContext, users: UserManager }

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// One server and one port for every instance; each instance is mounted under its own name.
export const startDashboard = (clients: DashboardClient[], port = dashboard.port) => {
    const byName = new Map(clients.map(client => [client.name, client]))
    const csrf = randomBytes(32).toString('base64url')
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer' }
    const assets = new Map([
        ['/', ['dashboard.html', 'text/html']],
        ['/dashboard.js', ['dashboard.js', 'text/javascript']],
        ['/dashboard.css', ['dashboard.css', 'text/css']],
    ].map(([path, [file, type]]) => [path, { content: readFileSync(new URL(file, import.meta.url), 'utf8'), type }]))
    const page = (path: string, body: BodyInit) => new Response(body, { status: 200, headers: { ...headers, 'Content-Type': `${assets.get(path)!.type}; charset=utf-8` } })
    const landing = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gork dashboards</title><link rel="stylesheet" href="dashboard.css"></head><body><main><h1>Gork dashboards</h1><ul class="dashboards">${clients.map(client => `<li><a href="/${encodeURIComponent(client.name)}/">${escape(client.name)}</a></li>`).join('')}</ul></main></body></html>`

    return Bun.serve({ hostname: dashboard.hostname, port, async fetch(request) {
        const url = new URL(request.url)
        const response = (body: BodyInit | null, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...headers, ...extra } })
        const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => response(JSON.stringify(value), status, { 'Content-Type': 'application/json', ...extra })
        if (request.method === 'GET' && url.pathname === '/') return response(landing(), 200, { 'Content-Type': 'text/html; charset=utf-8' })
        const [, name = '', ...rest] = url.pathname.split('/')
        const rootAsset = assets.get(url.pathname)
        if (request.method === 'GET' && rootAsset) return page(url.pathname, rootAsset.content)
        const client = byName.get(name)
        if (!client) return json({ error: 'not found' }, 404)
        // Relative asset URLs need the trailing slash, so a bare /name redirects to /name/.
        if (rest.length === 0 && !url.pathname.endsWith('/')) return response(null, 308, { Location: `${url.pathname}/` })
        const path = '/' + rest.join('/')
        const asset = assets.get(path)
        if (request.method === 'GET' && asset) return page(path, asset.content)
        const origin = request.headers.get('origin')
        if (request.method !== 'GET' && (origin !== url.origin || request.headers.get('content-type') !== 'application/json')) return json({ error: 'invalid request origin or content type' }, 403)
        if (request.method === 'GET' && path === '/api/state') return json({ csrf, ...await dashboardState(client.context, client.users) })
        if (request.method !== 'POST' || request.headers.get('x-csrf-token') !== csrf) return json({ error: 'invalid request' }, 403)
        const data = await request.json() as any
        let result: unknown
        switch (path) {
            case '/api/config': result = client.context.config.setConfig(data); break
            case '/api/moderation': result = client.context.config.setModeration(data); break
            case '/api/timeouts/remove': result = client.context.blacklist.clearTimeout(data.userId); break
            case '/api/persona': result = client.context.persona.set(data.content); break
            case '/api/persona/reset': result = client.context.persona.reset(); break
            case '/api/memory/add': client.context.memory.addFact(data); result = 'memory added'; break
            case '/api/memory/delete': result = client.context.memory.deleteFactAt(data.userId, Number(data.number)); break
            case '/api/memory/clear': result = client.context.memory.nukeFacts(data.userId || undefined); break
            case '/api/blacklist/add': result = client.context.blacklist.add(data.userId); break
            case '/api/blacklist/remove': result = client.context.blacklist.remove(data.userId); break
            case '/api/usage': result = await dashboardUsage(client.context, data, client.users); break
            default: return json({ error: 'not found' }, 404)
        }
        if (typeof result === 'string' && data.userId) result = result.replaceAll(data.userId, (await client.users.fetch(data.userId)).username)
        return json({ result })
    } })
}
