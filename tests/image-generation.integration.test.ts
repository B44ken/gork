import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codexFixture } from './fixtures/setup.ts'

const paths = Object.fromEntries(['image-generation', 'config', 'state', 'usage'].map(name => [name, JSON.stringify(join(import.meta.dir, `../bot/${name}.ts`))]))

test('Codex generation and multi-image edits attach images and persist failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muoft-images-'))
    try {
        const image = join(dir, 'generated.png')
        writeFileSync(image, 'generated image fixture')
        const executable = codexFixture(dir, [{ image }, { image }, { error: 'generation failed' }])
        const script = `
            import { createState } from ${paths.state};
            import { createConfig } from ${paths.config};
            import { createUsage } from ${paths.usage};
            import { createImageGeneration } from ${paths['image-generation']};
            const config = createConfig(createState('.')).config;
            const { run } = createImageGeneration({ config, track: createUsage('.').trackCodexTurn });
            const first = 'data:image/png;base64,YQ==', second = 'data:image/png;base64,Yg==';
            const context = { images: [{ source: 'current message', urls: [first, second] }] };
            const args = { prompt: 'draw', action: 'generate', size: '1024x1024', quality: 'low' };
            await run(args, context);
            await run({ ...args, prompt: 'combine both', action: 'edit' }, context);
            let failed = false;
            try { await run({ ...args, prompt: 'fail' }, context) } catch (error) { failed = error.message === 'generation failed' }
            const missing = await run({ ...args, action: 'edit' }, {});
            console.log(JSON.stringify({ files: context.generatedImages.map(file => file.attachment.toString()), failed, missing }));
        `
        const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, CODEX_BIN: executable }, encoding: 'utf8', timeout: 10000 })
        expect(result.stderr).toBe('')
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ files: ['generated image fixture', 'generated image fixture'], failed: true, missing: 'attach or reply to an image to edit it' })
        const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const edits = events.filter(event => event.method === 'turn/start')[1].params.input
        expect(edits.filter((item: any) => item.type === 'image').map((item: any) => item.url)).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='])
        expect(events.find(event => event.method === 'thread/start').params.config.features.image_generation).toBe(true)
        const db = new Database(join(dir, 'usage.sqlite'), { readonly: true })
        expect(db.query('SELECT source, provider, status, total_tokens FROM usage_requests ORDER BY rowid').all()).toEqual([
            { source: 'image-generation', provider: 'codex', status: 'completed', total_tokens: 120 },
            { source: 'image-generation', provider: 'codex', status: 'completed', total_tokens: 120 },
            { source: 'image-generation', provider: 'codex', status: 'failed', total_tokens: null },
        ])
        db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
