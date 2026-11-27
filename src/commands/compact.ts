// compact: queue a /compact for the agent session; it runs after the current turn ends.
import { defineCommand } from 'just-bash'
import type { CommandContext } from '../shell.ts'

export default ({ instance }: CommandContext) => defineCommand('compact', async args => {
    if (!instance.thread) return { stdout: '', stderr: 'compact: no thread\n', exitCode: 1 }
    instance.thread.push(['/compact', ...args].join(' '))
    return { stdout: 'compaction queued, runs after this turn\n', stderr: '', exitCode: 0 }
})
