import type { Config } from './config.ts'
import type { Chats } from './bot.ts'
import { messageInitiator, type Initiator } from './initiator.ts'
import { run as runCodex, type Input } from './codex.ts'
import type { Usage } from './usage.ts'

export type ImageGeneration = {
    run: (args: {
        prompt: string, action: 'generate' | 'edit',
        size: 'auto' | '1024x1024' | '1536x1024' | '1024x1536',
        quality: 'auto' | 'low' | 'medium' | 'high',
    }, context: Chats) => Promise<string>,
}

type Args = Parameters<ImageGeneration['run']>[0]
type ImageUsage = { input_tokens: number, output_tokens: number, total_tokens: number }

const endpoint = 'https://api.openai.com/v1/images'

const request = async (url: string, init: RequestInit) => {
    const response = await fetch(url, init)
    const body = await response.json().catch(() => null) as any
    if (!response.ok) throw new Error(body?.error?.message ?? `image request failed (${response.status})`)
    return body
}

// Codex's image tool needs ChatGPT auth and Claude can't draw, so api and claude-code modes talk to the Images API directly.
const generateWithApi = async (key: string, args: Args, model: string, context: Chats, trackImage?: Usage['trackImage']) => {
    const initiator: Initiator | null = messageInitiator(context)
    const urls = (context.images ?? []).flatMap(group => group.urls)
    if (args.action === 'edit' && !urls.length) return 'attach or reply to an image to edit it'
    try {
        let body: any
        if (args.action === 'generate') {
            body = await request(`${endpoint}/generations`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: args.prompt, size: args.size, quality: args.quality, n: 1 }),
            })
        } else {
            const form = new FormData()
            form.set('model', model); form.set('prompt', args.prompt); form.set('size', args.size); form.set('quality', args.quality); form.set('n', '1')
            for (const [index, url] of urls.entries()) {
                const response = await fetch(url)
                const bytes = await response.arrayBuffer()
                if (!response.ok) throw new Error(`could not download image ${index + 1}`)
                form.append('image[]', new Blob([bytes], { type: response.headers.get('content-type') ?? 'image/png' }), `image-${index + 1}.png`)
            }
            body = await request(`${endpoint}/edits`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form })
        }
        const first = body.data?.[0]
        const image = first?.b64_json ? Buffer.from(first.b64_json, 'base64')
            : first?.url ? Buffer.from(await (await fetch(first.url)).arrayBuffer()) : undefined
        if (!image?.length) throw new Error('the image API returned no image')
        ;(context.generatedImages ??= []).push({ attachment: image, name: 'generated-1.png' })
        await trackImage?.({ model, size: args.size, quality: args.quality, status: 'completed', usage: (body.usage as ImageUsage | null) ?? null }, initiator)
        return 'image generated and will be attached to the reply'
    } catch (error) {
        await trackImage?.({ model, size: args.size, quality: args.quality, status: 'failed', usage: null }, initiator)
        throw error
    }
}

export const createImageGeneration = ({ config, track, trackImage, apiKey }: { config: Config, track: Usage['trackCodexTurn'], trackImage?: Usage['trackImage'], apiKey?: string }): ImageGeneration => ({
    run: async ({ prompt, action, size, quality }, context) => {
        // 'auto' leaves the choice to the bot, which uses the configured defaults.
        const resolved = { prompt, action, size: size === 'auto' ? config.image.size : size, quality: quality === 'auto' ? config.image.quality : quality } as Args
        if (config.backend !== 'codex') {
            const key = apiKey ?? process.env.OPENAI_API_KEY
            if (!key) return `image generation needs OPENAI_API_KEY in ${config.backend} mode`
            return generateWithApi(key, resolved, config.image.model, context, trackImage)
        }
        const images = (context.images ?? []).flatMap(group => group.urls)
        if (action === 'edit' && !images.length) return 'attach or reply to an image to edit it'
        const input: Input[] = [{ type: 'text', text: `${resolved.action} an image: ${resolved.prompt}\nRequested size: ${resolved.size}; quality: ${resolved.quality}.` },
            ...images.map(url => ({ type: 'image' as const, url }))]
        const result = await runCodex({
            source: 'image-generation', model: config.model, effort: config.thinking, backend: config.backend, claudeModel: config.claude_model, track,
            instructions: 'Use the image_generation tool to fulfill the image request. When editing, use the attached images. Return the generated image.',
            input, imageGeneration: true, initiator: messageInitiator(context),
        })
        // Codex can answer with text and no image, which used to look like a successful generation.
        if (!result.images.length) return result.finalResponse.trim() || 'image generation produced no image'
        ;(context.generatedImages ??= []).push(...result.images.map((attachment, index) => ({ attachment, name: `generated-${index + 1}.png` })))
        return 'image generated and will be attached to the reply'
    },
})
