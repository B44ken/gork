import { expect, test } from 'bun:test'
import { fetchFollowingRedirects, fetchResource, parseUrl, publicAddress, viewImage } from '../bot/view-image.ts'
import { ImageResult } from '../bot/image-result.ts'

const budget = () => ({ requests: 0, bytes: 0, signal: AbortSignal.timeout(5000) })

test('rejects unsafe urls, ports and non-public addresses', async () => {
    for (const url of ['file:///etc/passwd', 'http://user:password@example.com/', 'http://example.com:8080/', 'http://[::1]/', 'data:text/html,hi']) {
        expect(() => parseUrl(url)).toThrow()
        expect(await viewImage(url)).toBe('invalid or unsupported url')
    }
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::ffff:127.0.0.1']) {
        expect(publicAddress(address)).toBe(false)
    }
    expect(publicAddress('8.8.8.8')).toBe(true)
    for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://localhost/', 'http://169.254.169.254/']) {
        await expect(fetchResource(url, budget())).rejects.toThrow()
    }
})

test('network request budget and deadline are enforced before connecting', async () => {
    await expect(fetchResource('https://example.com/', { requests: 80, bytes: 0, signal: AbortSignal.timeout(5000) })).rejects.toThrow('request limit')
    await expect(fetchResource('https://example.com/', { requests: 0, bytes: 0, signal: AbortSignal.abort() })).rejects.toThrow()
})

test('follows redirects through the same guarded loader and bounds loops', async () => {
    const seen: string[] = []
    const load: typeof fetchResource = async (url, limits) => {
        seen.push(url)
        if (url === 'https://example.com/start') return { status: 301, headers: { location: '/next' }, body: Buffer.alloc(0) }
        if (url === 'https://example.com/next') return { status: 302, headers: { location: 'https://example.org/final' }, body: Buffer.alloc(0) }
        if (url === 'https://example.org/final') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('ok') }
        if (url === 'https://example.com/private') return { status: 302, headers: { location: 'http://127.0.0.1/' }, body: Buffer.alloc(0) }
        if (url === 'https://example.com/loop') return { status: 302, headers: { location: '/loop' }, body: Buffer.alloc(0) }
        return fetchResource(url, limits)
    }
    const result = await fetchFollowingRedirects('https://example.com/start', budget(), load)
    expect(result.url).toBe('https://example.org/final')
    expect(result.resource.body.toString()).toBe('ok')
    expect(seen).toEqual(['https://example.com/start', 'https://example.com/next', 'https://example.org/final'])
    await expect(fetchFollowingRedirects('https://example.com/private', budget(), load)).rejects.toThrow('address is not public')
    await expect(fetchFollowingRedirects('https://example.com/loop', budget(), load)).rejects.toThrow('too many redirects')
})

test('returns image bytes, follows redirects, and rejects pages and failed responses', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=', 'base64')
    const seen: string[] = []
    const load: typeof fetchResource = async (url, limits) => {
        seen.push(url)
        if (url === 'https://example.com/redirect') return { status: 302, headers: { location: '/image' }, body: Buffer.alloc(0) }
        if (url === 'https://example.com/image') return { status: 200, headers: { 'content-type': 'image/png; charset=binary' }, body: png }
        if (url === 'https://example.com/page') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<img src="/image">') }
        if (url === 'https://example.com/missing') return { status: 404, headers: { 'content-type': 'image/png' }, body: png }
        if (url === 'https://example.com/private') return { status: 302, headers: { location: 'http://127.0.0.1/' }, body: Buffer.alloc(0) }
        return fetchResource(url, limits)
    }
    const result = await viewImage('https://example.com/redirect', load)
    expect(result).toBeInstanceOf(ImageResult)
    expect((result as ImageResult).dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(seen).toEqual(['https://example.com/redirect', 'https://example.com/image'])
    expect(await viewImage('https://example.com/page', load)).toBe('url did not return a supported image')
    expect(await viewImage('https://example.com/missing', load)).toBe('url did not return a supported image')
    expect(await viewImage('https://example.com/private', load)).toContain('unable to view image')
})
