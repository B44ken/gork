// img: image ops via sharp on workspace files.
//   img info <in>                         size/format
//   img resize <in> <out> <w> [h]         fit inside w x h
//   img blend <a> <b> <out> [opacity]     b over a (resized to a), opacity 0-1 (default 0.5)
//   img side <a> <b> <out>                a and b side by side, same height
//   img gray|flip|flop|negate <in> <out>
import { defineCommand } from 'just-bash'
import sharp from 'sharp'

const usage = 'usage: img info|resize|blend|side|gray|flip|flop|negate ... (see src/commands/img.ts)\n'
const fail = (msg: string, code = 1) => ({ stdout: '', stderr: msg, exitCode: code })

export default () => defineCommand('img', async (args, ctx) => {
    const [op, ...rest] = args
    const p = (x: string) => ctx.fs.resolvePath(ctx.cwd, x)
    const read = async (x: string) => Buffer.from(await ctx.fs.readFileBuffer(p(x)))
    const write = async (x: string, buf: Buffer) => { await ctx.fs.writeFile(p(x), new Uint8Array(buf)); return { stdout: `wrote ${p(x)} (${buf.length} bytes)\n`, stderr: '', exitCode: 0 } }
    const fmt = (out: string) => (out.split('.').pop() ?? 'png').toLowerCase().replace('jpg', 'jpeg') as 'png' | 'jpeg' | 'webp' | 'gif'
    try {
        switch (op) {
            case 'info': {
                const m = await sharp(await read(rest[0]!)).metadata()
                return { stdout: `${m.format} ${m.width}x${m.height}${m.hasAlpha ? ' alpha' : ''}\n`, stderr: '', exitCode: 0 }
            }
            case 'resize': {
                const [i, o, w, h] = rest
                if (!i || !o || !w) return fail(usage, 2)
                return write(o, await sharp(await read(i)).resize(Number(w), h ? Number(h) : undefined, { fit: 'inside' }).toFormat(fmt(o)).toBuffer())
            }
            case 'blend': {
                const [a, b, o, op = '0.5'] = rest
                if (!a || !b || !o) return fail(usage, 2)
                const base = sharp(await read(a)).ensureAlpha()
                const { width, height } = await base.metadata()
                const top = await sharp(await read(b)).resize(width, height, { fit: 'cover' }).ensureAlpha()
                    .composite([{ input: Buffer.from([255, 255, 255, Math.round(255 * Number(op))]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
                    .png().toBuffer()
                return write(o, await base.composite([{ input: top }]).toFormat(fmt(o)).toBuffer())
            }
            case 'side': {
                const [a, b, o] = rest
                if (!a || !b || !o) return fail(usage, 2)
                const h = (await sharp(await read(a)).metadata()).height!
                const [ia, ib] = await Promise.all([a, b].map(async x => sharp(await read(x)).resize({ height: h }).png().toBuffer()))
                const [ma, mb] = await Promise.all([ia!, ib!].map(x => sharp(x).metadata()))
                return write(o, await sharp({ create: { width: ma!.width! + mb!.width!, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
                    .composite([{ input: ia!, left: 0, top: 0 }, { input: ib!, left: ma!.width!, top: 0 }]).toFormat(fmt(o)).toBuffer())
            }
            case 'gray': case 'flip': case 'flop': case 'negate': {
                const [i, o] = rest
                if (!i || !o) return fail(usage, 2)
                const s = sharp(await read(i))
                const t = op === 'gray' ? s.grayscale() : op === 'flip' ? s.flip() : op === 'flop' ? s.flop() : s.negate({ alpha: false })
                return write(o, await t.toFormat(fmt(o)).toBuffer())
            }
            default: return fail(usage, 2)
        }
    } catch (error) {
        return fail(`img: ${error instanceof Error ? error.message : String(error)}\n`)
    }
})
