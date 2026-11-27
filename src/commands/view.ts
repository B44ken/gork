// view <path>: show an image file (e.g. a /chat attachment) to the model with this command's result.
import { defineCommand } from 'just-bash'
import { fileTypeFromBuffer } from 'file-type'
import type { CommandContext } from '../shell.ts'

const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const maxBytes = 5 * 1024 * 1024

export default ({ images }: CommandContext) => defineCommand('view', async (args, ctx) => {
    if (!args[0]) return { stdout: '', stderr: 'usage: view <image path>\n', exitCode: 2 }
    const path = ctx.fs.resolvePath(ctx.cwd, args[0])
    const bytes = await ctx.fs.readFileBuffer(path)
    const type = await fileTypeFromBuffer(bytes)
    if (!type || !supported.includes(type.mime)) return { stdout: '', stderr: `view: ${path} is not a png, jpeg, webp or gif\n`, exitCode: 1 }
    if (bytes.length > maxBytes) return { stdout: '', stderr: `view: ${path} is over 5 MB\n`, exitCode: 1 }
    images.push({ data: Buffer.from(bytes).toString('base64'), mimeType: type.mime })
    return { stdout: `showing ${path} (${type.mime}, ${bytes.length} bytes)\n`, stderr: '', exitCode: 0 }
})
