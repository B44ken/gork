import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Scenario } from './codex.ts'

export const codexFixture = (directory: string, scenarios: Scenario[]) => {
    writeFileSync(join(directory, 'scenarios.json'), JSON.stringify(scenarios))
    writeFileSync(join(directory, 'events.jsonl'), '')
    const executable = join(directory, 'codex')
    writeFileSync(executable, `#!/usr/bin/env bun\nimport { serve } from ${JSON.stringify(join(import.meta.dir, 'codex.ts'))}; serve(${JSON.stringify(directory)});\n`)
    chmodSync(executable, 0o700)
    return executable
}
