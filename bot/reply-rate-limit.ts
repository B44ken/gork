export const ownerUserId = '143771295832735745'

export const createReplyRateLimit = (now = Date.now) => {
    const requests = new Map<string, number[]>()
    return (userId: string, limit: number, windowSeconds: number): boolean => {
        if (userId === ownerUserId) return true
        const timestamp = now()
        const cutoff = timestamp - windowSeconds * 1000
        const recent = (requests.get(userId) ?? []).filter(timestamp => timestamp > cutoff)
        if (recent.length >= limit) {
            requests.set(userId, recent)
            return false
        }
        recent.push(timestamp)
        requests.set(userId, recent)
        return true
    }
}
