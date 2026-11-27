// deploy: typecheck and test /src, then hot-load it. Nothing changes if a check fails.
import { defineCommand } from 'just-bash'
import type { CommandContext } from '../shell.ts'

export default ({ kernel }: CommandContext) => defineCommand('deploy', async () => {
    const result = await kernel.deploy()
    return { stdout: `${result}\n`, stderr: '', exitCode: result.startsWith('deployed') ? 0 : 1 }
})
