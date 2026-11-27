import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const usageModule = join(import.meta.dir, '../bot/usage.ts')

function run(script: string) {
    const dir = mkdtempSync(join(tmpdir(), 'muoft-usage-'))
    try {
        const child = spawnSync(process.execPath, ['-e', `import { Database } from 'bun:sqlite'; import { createUsage } from ${JSON.stringify(usageModule)}; const { trackCodexTurn, trackExaSearch, inspectUsage } = createUsage('.'); ${script}`], { cwd: dir, encoding: 'utf8' })
        expect(child.stderr).toBe('')
        expect(child.status).toBe(0)
        const db = new Database(join(dir, 'usage.sqlite'), { readonly: true })
        try { return { rows: db.query('SELECT * FROM usage_requests ORDER BY rowid').all() as any[], mode: statSync(join(dir, 'usage.sqlite')).mode & 0o777, output: child.stdout } }
        finally { db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('Codex and Exa requests persist usage, attribution and failures without private content', () => {
    const { rows, mode } = run(`
        const initiator = { type: 'discord_message', message_id: 'message', channel_id: 'channel', guild_id: 'guild', user_id: 'user' };
        await trackCodexTurn('gpt-6-luna', 'low', async () => ({ finalResponse: 'private-response-sentinel', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, reasoning_output_tokens: 5, cache_write_input_tokens: 3 } }), () => 'thread', initiator, 'chat');
        await trackExaSearch(async () => ({ requestId: 'search', results: ['private-search-sentinel'], costDollars: { total: 0.02 }, resolvedSearchType: 'neural' }), initiator);
        try { await trackCodexTurn('gpt-6-luna', 'low', async () => { throw new Error('private-error-sentinel') }, () => 'failed-thread', initiator, 'agent') } catch (error) { if (error.message !== 'private-error-sentinel') throw error }
        const result = await inspectUsage({ start_date: null, end_date: null, group_by: 'initiator' });
        if (result.rows[0].requests !== 3 || result.rows[0].usage_group.user_id !== 'user') throw new Error('lost attribution');
    `)
    expect(mode).toBe(0o600)
    expect(rows[0]).toMatchObject({ provider: 'codex', source: 'chat', scope: 'codex_turn', thread_id: 'thread', requested_model: 'gpt-6-luna', model: null, input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_input_tokens: 40, cache_write_tokens: 3, reasoning_output_tokens: 5, estimated_cost_usd: null })
    expect(rows[1]).toMatchObject({ provider: 'exa', provider_request_id: 'search', reported_cost_usd: 0.02 })
    expect(rows[2]).toMatchObject({ source: 'agent', status: 'failed', input_tokens: null })
    expect(JSON.stringify(rows)).not.toContain('private-')
})

test('rolling windows, exclusive millisecond bounds and historical costs remain read-only', () => {
    run(`
        const args = { start_date: null, end_date: null, group_by: 'total' };
        if (await inspectUsage(args) !== 'no usage database exists yet') throw new Error('missing database');
        await trackExaSearch(async () => ({ costDollars: { total: 1 } }));
        const db = new Database('usage.sqlite'), now = Date.now();
        const insert = db.query("INSERT INTO usage_requests (request_id, started_at, source, scope, provider, status, estimated_cost_usd) VALUES (?, ?, 'chat', 'response', 'openai', 'completed', ?)");
        for (const [id, time, cost] of [['before', now - 240 * 60000 - 10000, 10], ['inside', now - 240 * 60000 + 10000, 2], ['future', now + 60000, 100]]) insert.run(id, new Date(time).toISOString(), cost);
        const before = JSON.stringify(db.query('SELECT * FROM usage_requests').all());
        const rolling = await inspectUsage({ ...args, last_minutes: 240 });
        if (rolling.rows[0].requests !== 2 || rolling.rows[0].known_cost_usd !== 3) throw new Error('rolling selection');
        const exact = await inspectUsage({ ...args, start_date: new Date(now - 240 * 60000 + 10000).toISOString(), end_date: new Date(now - 240 * 60000 + 10001).toISOString() });
        if (exact.rows[0].requests !== 1 || exact.rows[0].known_cost_usd !== 2) throw new Error('millisecond bounds');
        const empty = await inspectUsage({ ...args, start_date: new Date(now - 240 * 60000 + 9999).toISOString(), end_date: new Date(now - 240 * 60000 + 10000).toISOString() });
        if (empty.rows.length) throw new Error('exclusive end');
        if (typeof await inspectUsage({ ...args, last_minutes: 0 }) !== 'string') throw new Error('invalid minutes');
        if (typeof await inspectUsage({ ...args, last_minutes: 1, start_date: '2001-01-01' }) !== 'string') throw new Error('ambiguous bounds');
        if (JSON.stringify(db.query('SELECT * FROM usage_requests').all()) !== before) throw new Error('inspection changed history');
        db.close();
    `)
})

test('usage groups stay bounded and read-only with a legacy schema', () => {
    run(`
        await trackExaSearch(async () => ({}));
        const db = new Database('usage.sqlite');
        db.exec("ALTER TABLE usage_requests DROP COLUMN initiator");
        db.exec(${JSON.stringify("WITH RECURSIVE days(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM days WHERE n < 100) INSERT INTO usage_requests (request_id, started_at, source, scope, provider, status) SELECT 'fixture-' || n, date('2000-01-01', '+' || n || ' days') || 'T00:00:00.000Z', 'chat', 'response', 'openai', 'completed' FROM days")});
        const result = await inspectUsage({ start_date: null, end_date: null, group_by: 'day' });
        if (!result.truncated || result.rows.length !== 100) throw new Error('unbounded groups');
        const legacy = await inspectUsage({ start_date: null, end_date: null, group_by: 'initiator' });
        if (legacy.rows.length !== 1 || legacy.rows[0].usage_group !== null) throw new Error('legacy attribution');
        if (db.query('PRAGMA table_info(usage_requests)').all().some(column => column.name === 'initiator')) throw new Error('read-only inspection migrated schema');
        db.close();
    `)
})

test('storage failures prevent dispatch and permit recovery', () => {
    const { rows } = run(`
        const { mkdirSync, rmdirSync } = await import('node:fs');
        mkdirSync('usage.sqlite');
        let called = 0;
        for (const call of [
            () => trackCodexTurn('gpt-6-luna', 'low', async () => { called++; return { usage: null } }, () => 'thread'),
            () => trackExaSearch(async () => { called++; return {} }),
        ]) {
            let failed = false;
            try { await call() } catch { failed = true }
            if (!failed) throw new Error('storage error was hidden');
        }
        if (called) throw new Error('dispatched without tracking');
        rmdirSync('usage.sqlite');
        await trackCodexTurn('gpt-6-luna', 'low', async () => ({ usage: null }), () => 'thread');
    `)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'codex', status: 'completed', thread_id: 'thread' })
})

test('concurrent turns preserve initiators through completion and failure', () => {
    const { rows } = run(`
        const first = { type: 'discord_message', message_id: 'first', channel_id: 'a', guild_id: null, user_id: 'user-a' };
        const second = { ...first, message_id: 'second', channel_id: 'b', user_id: 'user-b' };
        let releaseFirst, releaseSecond, startedFirst, startedSecond;
        const readyFirst = new Promise(resolve => startedFirst = resolve), readySecond = new Promise(resolve => startedSecond = resolve);
        const pendingFirst = trackCodexTurn('gpt-6-luna', 'low', () => new Promise(resolve => { releaseFirst = resolve; startedFirst() }), () => 'one', first, 'chat');
        const pendingSecond = trackCodexTurn('gpt-6-luna', 'low', () => new Promise((resolve, reject) => { releaseSecond = reject; startedSecond() }), () => 'two', second, 'agent');
        await Promise.all([readyFirst, readySecond]);
        const db = new Database('usage.sqlite');
        if (db.query("SELECT COUNT(*) AS n FROM usage_requests WHERE status = 'in_progress'").get().n !== 2) throw new Error('missing pending rows');
        releaseSecond(new Error('expected failure'));
        try { await pendingSecond; throw new Error('missing failure') } catch (error) { if (error.message !== 'expected failure') throw error }
        releaseFirst({ usage: null });
        await pendingFirst;
        db.close();
    `)
    expect(rows.map(row => [row.source, row.status, JSON.parse(row.initiator).message_id])).toEqual([
        ['chat', 'completed', 'first'], ['agent', 'failed', 'second'],
    ])
})

test('an interrupted turn remains in progress across process exit', () => {
    const { rows } = run("await trackCodexTurn('gpt-6-luna', 'low', async () => process.exit(0), () => 'thread');")
    expect(rows[0]).toMatchObject({ provider: 'codex', status: 'in_progress', input_tokens: null, estimated_cost_usd: null })
})
