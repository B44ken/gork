import type { StateStore } from './state.ts'

export const models = ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra']
export const backends = ['codex', 'api', 'claude-code']
export const claudeModels = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']
// Image models this account can use, newest first; the API-key account's /v1/models list is the source of truth.
export const imageModels = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest']
export const imageSizes = ['auto', '1024x1024', '1536x1024', '1024x1536']
export const imageQualities = ['auto', 'low', 'medium', 'high']
export const thinkingLevels = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
export const codingAgent = { model: 'gpt-6-luna', effort: 'high' } as const
export const dashboard = { hostname: '127.0.0.1', port: 6767 }

export type Moderation = { enabled: boolean, timeout_seconds: number, policy: string }
export type Config = {
    model: string, backend: 'codex' | 'api' | 'claude-code', claude_model: string, thinking: string, context: number,
    waffle: { chance: number, after_msgs: number }, moderation: Moderation,
    image: { model: string, size: string, quality: string },
    reply_rate_limit: { messages: number, window_seconds: number },
}

export const defaultConfig: Config = {
    waffle: { chance: 0.01, after_msgs: 10 },
    image: { model: 'gpt-image-2.6-flare', size: 'auto', quality: 'auto' },
    reply_rate_limit: { messages: 3, window_seconds: 60 },
    context: 20,
    thinking: 'low',
    model: 'gpt-6-luna',
    backend: 'codex',
    claude_model: 'claude-sonnet-5-5',
    moderation: {
        enabled: true,
        timeout_seconds: 300,
        policy: 'Classify the current request for a Discord bot. If a reason is provided, the offending user will be timed out. Do not time out users for benign requests - return null for those. Return only JSON with a "reason" field, whose value is either null or a reason strong like "terrorism", "weapons intended to harm people", "slur abuse", "sexual harassment", or "threat of drugging". rule of thumb: if you have to tell them to call 911, they\'re messing with you and need time out',
    },
}

type Setting = {
    key: string, command: string, type: 'string' | 'integer' | 'number',
    choices?: string[], min?: number, max?: number, multiline?: boolean,
}

export const settings: Setting[] = [
    { key: 'model', command: 'model', type: 'string', choices: models },
    { key: 'backend', command: 'backend', type: 'string', choices: backends },
    { key: 'claude_model', command: 'claude-model', type: 'string', choices: claudeModels },
    { key: 'context', command: 'context', type: 'integer', min: 1 },
    { key: 'thinking', command: 'thinking', type: 'string', choices: thinkingLevels },
    { key: 'image.model', command: 'image-model', type: 'string', choices: imageModels },
    { key: 'image.size', command: 'image-size', type: 'string', choices: imageSizes },
    { key: 'image.quality', command: 'image-quality', type: 'string', choices: imageQualities },
    { key: 'waffle.chance', command: 'waffle-chance', type: 'number', min: 0, max: 1 },
    { key: 'waffle.after_msgs', command: 'waffle-after-msgs', type: 'integer', min: 0 },
    { key: 'reply_rate_limit.messages', command: 'reply-rate-limit-messages', type: 'integer', min: 1 },
    { key: 'reply_rate_limit.window_seconds', command: 'reply-rate-limit-window-seconds', type: 'integer', min: 1 },
]

export type ConfigStore = {
    config: Config,
    settings: Setting[],
    value: (key: string) => string | number,
    setConfig: (change: { key: string, value: string }) => string,
    setModeration: (moderation: Moderation) => string,
}

export const createConfig = (store: StateStore): ConfigStore => {
    const stored = store.read().config ?? {}
    const { reply_limit: _legacyReplyLimit, ...persisted } = stored as Config & { reply_limit?: number }
    const config: Config = {
        ...structuredClone(defaultConfig),
        ...persisted,
        waffle: { ...defaultConfig.waffle, ...stored.waffle },
        moderation: { ...defaultConfig.moderation, ...stored.moderation },
        image: { ...defaultConfig.image, ...stored.image },
        reply_rate_limit: { ...defaultConfig.reply_rate_limit, ...stored.reply_rate_limit },
    }

    const save = () => store.update(state => { state.config = config })
    const requiresThinking = () => config.model === 'gpt-6-astra' || config.model === 'gpt-6.1-sol'
    const value = (key: string): string | number => key.split('.').reduce((value, part) => value[part], config as any)

    const setModeration = (moderation: Moderation) => {
        if (!Number.isInteger(moderation.timeout_seconds) || moderation.timeout_seconds < 1) return 'timeout must be a positive number of seconds'
        if (!moderation.policy.trim()) return 'moderation policy must not be empty'
        config.moderation = { ...moderation, policy: moderation.policy.trim() }
        save()
        return 'moderation updated'
    }

    const setConfig = ({ key, value }: { key: string, value: string }) => {
        const setting = settings.find(setting => setting.key === key)
        if (!setting) return `unknown key. use one of: ${settings.map(setting => setting.key).join(', ')}`
        const previousThinking = config.thinking
        if (key === 'model') {
            const aliases = Object.fromEntries(models.map(model => [model.split('-').at(-1), model]))
            value = aliases[value] ?? value
        }
        if (setting.choices && !setting.choices.includes(value)) return `${key} must be one of: ${setting.choices.join(', ')}`
        if (key === 'thinking' && value === 'none' && requiresThinking()) return `${config.model} requires thinking: low`

        let parsed: string | number = value
        if (setting.type !== 'string') {
            parsed = Number(value)
            if (!Number.isFinite(parsed) || (setting.type === 'integer' && !Number.isInteger(parsed)) ||
                (setting.min !== undefined && parsed < setting.min) || (setting.max !== undefined && parsed > setting.max)) {
                return `${key} must be ${setting.type === 'integer' ? 'an integer' : 'a number'} >= ${setting.min}${setting.max === undefined ? '' : ` and <= ${setting.max}`}`
            }
        }
        const parts = key.split('.'), field = parts.pop()!
        const target = parts.reduce((value, part) => value[part], config as any)
        target[field] = parsed
        if (key === 'model' && config.thinking === 'none' && requiresThinking()) config.thinking = 'low'
        save()
        return `set config.${key}=${value}${key === 'model' && config.thinking !== previousThinking ? ' (thinking set to low)' : ''}`
    }

    return { config, settings, value, setConfig, setModeration }
}
