import { closeSync, existsSync, openSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Usage as CodexUsage } from '@openai/codex-sdk'
import type { Initiator } from './initiator.ts'

const usageGroups = {
    total: "'all'",
    day: 'date(started_at)',
    source: "CASE source WHEN 'chat' THEN 'chat' WHEN 'agent' THEN 'agent' WHEN 'monkeypatch' THEN 'monkeypatch' WHEN 'web-search' THEN 'web-search' WHEN 'image-generation' THEN 'image-generation' ELSE 'other' END",
    model: "CASE model WHEN 'gpt-6-astra' THEN 'gpt-6-astra' WHEN 'gpt-6.1-sol' THEN 'gpt-6.1-sol' WHEN 'gpt-6.1-terra' THEN 'gpt-6.1-terra' WHEN 'gpt-6-luna' THEN 'gpt-6-luna' ELSE 'other or unreported' END",
    requested_model: "CASE requested_model WHEN 'gpt-6-astra' THEN 'gpt-6-astra' WHEN 'gpt-6.1-sol' THEN 'gpt-6.1-sol' WHEN 'gpt-6.1-terra' THEN 'gpt-6.1-terra' WHEN 'gpt-6-luna' THEN 'gpt-6-luna' WHEN 'gpt-image-2.6-flare' THEN 'gpt-image-2.6-flare' ELSE 'other or unreported' END",
    provider: "CASE provider WHEN 'openai' THEN 'openai' WHEN 'openai-compatible' THEN 'openai-compatible' WHEN 'codex' THEN 'codex' WHEN 'exa' THEN 'exa' ELSE 'other' END",
    initiator: 'initiator',
} as const

export type InspectOptions = {
    start_date: string | null, end_date: string | null,
    last_minutes?: number | null, group_by: keyof typeof usageGroups,
}

export type UsageResult = {
    group_by: keyof typeof usageGroups, start_date: string | null, end_date: string | null,
    last_minutes: number | null | undefined, start_at: string | null, end_at: string | null,
    rows: any[], truncated: boolean, note: string,
}

type Row = {
    request_id: string, started_at: string, source: string, scope: string, provider: string,
    requested_model: string | null, model: string | null, provider_request_id: string | null, response_id: string | null, thread_id: string | null,
    status: string, service_tier: string | null, reasoning_effort: string | null,
    input_tokens: number | null, output_tokens: number | null, total_tokens: number | null,
    cached_input_tokens: number | null, cache_write_tokens: number | null,
    cache_write_30m_tokens: number | null, cache_write_12h_tokens: number | null,
    reasoning_output_tokens: number | null, estimated_cost_usd: number | null, price_version: string | null,
    reported_cost_usd: number | null, usage_metadata_json: string | null, cache_write_lifetime_source: string | null, initiator: string | null,
}

// Exa reports a search cost, but not its internal model or token usage.
type ExaSearch = {
    requestId?: string, resolvedSearchType?: string, searchTime?: number,
    costDollars?: { total: number, search?: { neural?: number, keyword?: number }, contents?: { text?: number, highlights?: number, summary?: number } }
}

export type Usage = {
    inspectUsage: (options: InspectOptions) => Promise<UsageResult | string>,
    trackCodexTurn: <T extends { usage: CodexUsage | null }>(model: string, effort: string, run: () => Promise<T>, threadId: () => string | null, initiator?: Initiator | null, source?: 'chat' | 'agent' | 'monkeypatch' | 'image-generation') => Promise<T>,
    trackExaSearch: <T extends ExaSearch>(request: () => Promise<T>, initiator?: Initiator | null) => Promise<T>,
    trackImage: (details: {
        model: string, size: string, quality: string, status: 'completed' | 'failed',
        usage: { input_tokens: number, output_tokens: number, total_tokens: number } | null,
    }, initiator?: Initiator | null) => Promise<void>,
}

export const createUsage = (directory: string): Usage => {
    const file = join(directory, 'usage.sqlite')
    let database: Database | undefined

    const getDatabase = () => {
        if (database) return database
        // Create with private permissions before SQLite opens its journal.
        closeSync(openSync(file, 'a', 0o600))
        const db = new Database(file)
        db.exec(`PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS usage_requests (
                request_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, source TEXT NOT NULL,
                scope TEXT NOT NULL, provider TEXT NOT NULL, requested_model TEXT,
                model TEXT, provider_request_id TEXT, response_id TEXT, thread_id TEXT, status TEXT NOT NULL,
                service_tier TEXT, reasoning_effort TEXT,
                input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
                cached_input_tokens INTEGER, cache_write_tokens INTEGER,
                cache_write_30m_tokens INTEGER, cache_write_12h_tokens INTEGER,
                reasoning_output_tokens INTEGER, estimated_cost_usd REAL, price_version TEXT,
                reported_cost_usd REAL, usage_metadata_json TEXT, cache_write_lifetime_source TEXT, initiator TEXT
            );
            CREATE INDEX IF NOT EXISTS usage_requests_started_at ON usage_requests(started_at);`)
        db.exec('BEGIN IMMEDIATE')
        try {
            const columns = db.prepare<{ name: string }, []>('PRAGMA table_info(usage_requests)').all()
            if (!columns.some(column => column.name === 'cache_write_lifetime_source')) db.exec('ALTER TABLE usage_requests ADD COLUMN cache_write_lifetime_source TEXT')
            if (!columns.some(column => column.name === 'initiator')) db.exec('ALTER TABLE usage_requests ADD COLUMN initiator TEXT')
            db.exec('COMMIT')
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        }
        return database = db
    }

    const start = async (row: Row) => {
        const db = getDatabase()
        const columns = Object.keys(row)
        db.prepare(`INSERT INTO usage_requests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row))
    }
    const finish = async (row: Row) => {
        const db = getDatabase()
        const columns = Object.keys(row).filter(column => column !== 'request_id') as (keyof Row)[]
        db.prepare(`UPDATE usage_requests SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE request_id = ?`).run(...columns.map(column => row[column]), row.request_id)
    }

    const baseRow = (source: string, scope: string, provider: string, model: string | null, effort: string | null, initiator?: Initiator | null): Row => ({
        request_id: randomUUID(), started_at: new Date().toISOString(), source, scope, provider,
        requested_model: model, model: null, provider_request_id: null, response_id: null, thread_id: null,
        status: 'in_progress', service_tier: null, reasoning_effort: effort,
        input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null,
        cache_write_tokens: null, cache_write_30m_tokens: null, cache_write_12h_tokens: null,
        reasoning_output_tokens: null, estimated_cost_usd: null, price_version: null, reported_cost_usd: null, usage_metadata_json: null, cache_write_lifetime_source: null,
        initiator: initiator ? JSON.stringify(initiator) : null,
    })

    const trackCodexTurn: Usage['trackCodexTurn'] = async (model, effort, run, threadId, initiator, source = 'monkeypatch') => {
        const row = baseRow(source, 'codex_turn', 'codex', model, effort, initiator)
        await start(row)
        let result
        try {
            result = await run()
        } catch (error) {
            row.status = 'failed'
            await finish(row)
            throw error
        }
        const usage = result.usage
        row.thread_id = threadId() ?? null
        row.status = 'completed'
        // Codex reports turn totals, not the models used for individual calls.
        row.input_tokens = usage?.input_tokens ?? null
        row.output_tokens = usage?.output_tokens ?? null
        row.total_tokens = usage ? usage.input_tokens + usage.output_tokens : null
        row.cached_input_tokens = usage?.cached_input_tokens ?? null
        row.cache_write_tokens = usage?.cache_write_input_tokens ?? null
        row.reasoning_output_tokens = usage?.reasoning_output_tokens ?? null
        await finish(row)
        return result
    }

    const trackExaSearch: Usage['trackExaSearch'] = async (request, initiator) => {
        const row = baseRow('web-search', 'api_request', 'exa', null, null, initiator)
        await start(row)
        let result
        try {
            result = await request()
        } catch (error) {
            row.status = 'failed'
            await finish(row)
            throw error
        }
        row.status = 'completed'
        row.provider_request_id = result.requestId ?? null
        row.reported_cost_usd = result.costDollars?.total ?? null
        row.usage_metadata_json = JSON.stringify({
            search_type: ['neural', 'keyword'].includes(result.resolvedSearchType ?? '') ? result.resolvedSearchType : null,
            search_time_ms: result.searchTime ?? null,
            neural_usd: result.costDollars?.search?.neural ?? null,
            keyword_usd: result.costDollars?.search?.keyword ?? null,
            text_usd: result.costDollars?.contents?.text ?? null,
            highlights_usd: result.costDollars?.contents?.highlights ?? null,
            summary_usd: result.costDollars?.contents?.summary ?? null,
        })
        await finish(row)
        return result
    }

    const trackImage: Usage['trackImage'] = async ({ model, size, quality, status, usage }, initiator) => {
        const row = baseRow('image-generation', 'api_request', 'openai', model, null, initiator)
        row.model = model
        row.status = status
        row.input_tokens = usage?.input_tokens ?? null
        row.output_tokens = usage?.output_tokens ?? null
        row.total_tokens = usage?.total_tokens ?? null
        row.usage_metadata_json = JSON.stringify({ size, quality })
        await start(row)
    }

    const inspectUsage: Usage['inspectUsage'] = async ({ start_date, end_date, last_minutes = null, group_by }) => {
        const utc = (value: string | null) => {
            if (value === null) return null
            if (typeof value !== 'string') return undefined
            const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z)?$/.exec(value)
            if (!match) return undefined
            const iso = `${match[1]}T${match[2] ?? '00:00:00'}.${(match[3] ?? '').padEnd(3, '0')}Z`
            const time = Date.parse(iso)
            return Number.isFinite(time) && new Date(time).toISOString() === iso ? iso : undefined
        }
        let start_at = utc(start_date), end_at = utc(end_date)
        if (start_at === undefined || end_at === undefined || (start_at && end_at && start_at >= end_at)) return 'use valid UTC dates or timestamps, with start_date before the exclusive end_date'
        if (last_minutes !== null) {
            const now = Date.now()
            if (!Number.isSafeInteger(last_minutes) || last_minutes <= 0 || start_date !== null || end_date !== null || now - last_minutes * 60_000 < Date.parse('0000-01-01T00:00:00.000Z')) return 'last_minutes must be a positive whole number and cannot be combined with start_date or end_date'
            start_at = new Date(now - last_minutes * 60_000).toISOString()
            end_at = new Date(now).toISOString()
        }
        if (!Object.hasOwn(usageGroups, group_by)) return 'group_by must be total, day, source, model, requested_model, provider, or initiator'
        if (!existsSync(file)) return 'no usage database exists yet'

        const db = new Database(file, { readonly: true })
        try {
            const group = group_by === 'initiator' && !db.prepare('PRAGMA table_info(usage_requests)').all().some((column: { name: string }) => column.name === 'initiator')
                ? 'NULL' : usageGroups[group_by]
            const rows = db.prepare(`SELECT ${group} AS usage_group, COUNT(*) AS requests,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed_requests,
                COUNT(CASE WHEN status = 'in_progress' THEN 1 END) AS in_progress_requests,
                COUNT(model) AS model_reported_requests, COUNT(requested_model) AS requested_model_recorded,
                SUM(input_tokens) AS input_tokens, COUNT(input_tokens) AS input_tokens_recorded,
                SUM(output_tokens) AS output_tokens, COUNT(output_tokens) AS output_tokens_recorded,
                SUM(total_tokens) AS total_tokens, COUNT(total_tokens) AS total_tokens_recorded,
                SUM(cached_input_tokens) AS cached_input_tokens, COUNT(cached_input_tokens) AS cached_input_tokens_recorded,
                SUM(cache_write_tokens) AS cache_write_tokens, COUNT(cache_write_tokens) AS cache_write_tokens_recorded,
                SUM(cache_write_30m_tokens) AS cache_write_30m_tokens, COUNT(cache_write_30m_tokens) AS cache_write_30m_tokens_recorded,
                SUM(cache_write_12h_tokens) AS cache_write_12h_tokens, COUNT(cache_write_12h_tokens) AS cache_write_12h_tokens_recorded,
                SUM(reasoning_output_tokens) AS reasoning_output_tokens, COUNT(reasoning_output_tokens) AS reasoning_output_tokens_recorded,
                SUM(estimated_cost_usd) AS estimated_cost_usd, COUNT(estimated_cost_usd) AS estimated_cost_recorded,
                SUM(reported_cost_usd) AS reported_cost_usd, COUNT(reported_cost_usd) AS reported_cost_recorded,
                SUM(COALESCE(reported_cost_usd, estimated_cost_usd)) AS known_cost_usd,
                COUNT(COALESCE(reported_cost_usd, estimated_cost_usd)) AS priced_requests,
                COUNT(*) - COUNT(COALESCE(reported_cost_usd, estimated_cost_usd)) AS unpriced_requests
                FROM usage_requests WHERE (? IS NULL OR julianday(started_at) >= julianday(?)) AND (? IS NULL OR julianday(started_at) < julianday(?))
                GROUP BY ${group} ORDER BY usage_group DESC LIMIT 101`).all(start_at, start_at, end_at, end_at)
            const resultRows = rows.slice(0, 100).map((row: any) => group_by === 'initiator'
                ? { ...row, usage_group: row.usage_group === null ? null : JSON.parse(row.usage_group) } : row)
            return { group_by, start_date, end_date, last_minutes, start_at, end_at, rows: resultRows, truncated: rows.length > 100,
                note: 'UTC window uses request start times; start_at is inclusive and end_at exclusive. Model groups use only provider-reported models; requested_model groups show configured requests, not confirmed actual models. Counts show coverage and NULL sums have no data. known_cost_usd is a partial total when unpriced_requests is nonzero; it uses reported cost first, otherwise estimated cost, never both. Describe it as known/estimated usage cost, not a complete bill. Do not volunteer unpriced-request counts unless asked about coverage. Input includes cached reads and cache writes; output includes reasoning. Codex turns may include multiple models and cannot be priced from available data. Retries and external tool usage may be missing.' }
        } finally { db.close() }
    }

    return { inspectUsage, trackCodexTurn, trackExaSearch, trackImage }
}
