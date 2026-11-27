// search <query...>: web search through Exa.
import { defineCommand } from 'just-bash'
import Exa from 'exa-js'
import type { CommandContext } from '../shell.ts'

export default ({ instance }: CommandContext) => defineCommand('search', async args => {
    if (!args.length) return { stdout: '', stderr: 'usage: search <query>\n', exitCode: 2 }
    if (!instance.env.EXA_API_KEY) return { stdout: '', stderr: 'search: EXA_API_KEY is not set for this instance\n', exitCode: 1 }
    const { results } = await new Exa(instance.env.EXA_API_KEY).search(args.join(' '), { numResults: 5, contents: { highlights: { maxCharacters: 1000 } } })
    return { stdout: results.map(r => `## ${r.title}\n${r.url}\n${(r.highlights ?? []).join('\n')}`).join('\n\n') + '\n', stderr: '', exitCode: 0 }
})
