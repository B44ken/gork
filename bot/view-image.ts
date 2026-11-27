import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { ImageResult } from './image-result.ts'

const maxResourceBytes = 4 * 1024 * 1024
const maxTotalBytes = 12 * 1024 * 1024
const maxRequests = 80
const timeoutMs = 15000
let running = 0

type Resource = { status: number; headers: Record<string, string>; body: Buffer }
type Budget = { requests: number; bytes: number; signal: AbortSignal }

export const parseUrl = (value: string) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || value.length > 4096)
        throw new Error('unsupported url')
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) === 6) throw new Error('ipv6 is not supported')
    return url
}

export const publicAddress = (address: string) =>
    isIP(address) === 4 && ipaddr.parse(address).range() === 'unicast'

// Resolve once and connect to that address, so DNS cannot change between validation and connection.
export const fetchResource = async (value: string, budget: Budget): Promise<Resource> => {
    budget.signal.throwIfAborted()
    if (++budget.requests > maxRequests) throw new Error('request limit exceeded')
    const url = parseUrl(value)
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await new Promise<{ address: string }[]>((resolve, reject) => {
        const abort = () => reject(new Error('timed out'))
        budget.signal.addEventListener('abort', abort, { once: true })
        if (budget.signal.aborted) abort()
        lookup(url.hostname, { all: true, family: 4 }).then(resolve, reject).finally(() => budget.signal.removeEventListener('abort', abort))
    })
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('address is not public')
    budget.signal.throwIfAborted()
    return await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
            hostname: addresses[0].address,
            port: url.protocol === 'https:' ? 443 : 80,
            path: url.pathname + url.search,
            method: 'GET',
            servername: url.hostname,
            headers: { host: url.host, 'user-agent': 'Mozilla/5.0', accept: '*/*', 'accept-encoding': 'identity' },
            signal: budget.signal,
        }, response => {
            response.on('error', reject)
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                response.destroy(new Error('compressed response'))
                return
            }
            const chunks: Buffer[] = []
            let bytes = 0
            response.on('data', (chunk: Buffer) => {
                bytes += chunk.length
                budget.bytes += chunk.length
                if (bytes > maxResourceBytes || budget.bytes > maxTotalBytes) response.destroy(new Error('size limit exceeded'))
                else chunks.push(chunk)
            })
            response.on('end', () => {
                const headers: Record<string, string> = {}
                for (const name of ['content-type', 'location']) {
                    const value = response.headers[name]
                    if (typeof value === 'string') headers[name] = value
                }
                resolve({ status: response.statusCode!, headers, body: Buffer.concat(chunks) })
            })
        })
        request.on('error', reject)
        request.end()
    })
}

// Validate and fetch every redirect separately.
export const fetchFollowingRedirects = async (value: string, budget: Budget, load = fetchResource) => {
    let url = parseUrl(value)
    for (let redirects = 0; redirects <= 10; redirects++) {
        const resource = await load(url.href, budget)
        if (![301, 302, 303, 307, 308].includes(resource.status) || !resource.headers.location) {
            delete resource.headers.location
            return { url: url.href, resource }
        }
        url = parseUrl(new URL(resource.headers.location, url).href)
    }
    throw new Error('too many redirects')
}

export const viewImage = async (value: string, load = fetchResource): Promise<ImageResult | string> => {
    try { parseUrl(value) } catch { return 'invalid or unsupported url' }
    if (running >= 2) return 'image viewer is busy'
    running++
    try {
        const budget: Budget = { requests: 0, bytes: 0, signal: AbortSignal.timeout(timeoutMs) }
        const { resource } = await fetchFollowingRedirects(value, budget, load)
        const type = resource.headers['content-type']?.split(';')[0].trim().toLowerCase()
        if (resource.status !== 200 || !type || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))
            return 'url did not return a supported image'
        return new ImageResult(`data:${type};base64,${resource.body.toString('base64')}`)
    } catch (error) {
        console.error(`view-image failed: ${error instanceof Error ? error.name : 'error'}`)
        return 'unable to view image (unavailable, blocked, too large, or timed out)'
    } finally {
        running--
    }
}
