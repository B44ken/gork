const $ = id => document.getElementById(id)
const state = { file: null, channels: new Set(), authors: new Set(), offset: 0, limit: 50, total: 0, conversations: [], selected: null, meta: null }
let pending = null

const number = id => Number($(id).value) || 0
const checked = id => $(id).checked

const params = (extra = {}) => {
    const search = new URLSearchParams()
    if (state.file) search.set('file', state.file)
    for (const [key, value] of Object.entries(extra)) search.set(key, value)
    const text = $('q').value.trim()
    if (text) search.set('q', text)
    if (state.channels.size) search.set('channels', [...state.channels].join(','))
    if (state.authors.size) search.set('authors', [...state.authors].join(','))
    if ($('from').value) search.set('from', $('from').value)
    if ($('to').value) search.set('to', $('to').value)
    search.set('minTurns', number('minTurns'))
    search.set('minParticipants', number('minParticipants'))
    search.set('minChars', number('minChars'))
    search.set('maxChars', number('maxChars'))
    search.set('gap', number('gap'))
    search.set('attachments', $('attachments').value)
    search.set('includeBots', checked('includeBots') ? '1' : '0')
    search.set('clean', checked('clean') ? '1' : '0')
    search.set('dropUnanswered', checked('dropUnanswered') ? '1' : '0')
    search.set('sort', $('sort').value)
    return search
}

const node = (tag, className, text) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
}

const when = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const facets = (items, container, set, counts, label) => {
    container.replaceChildren(...items.map(item => {
        const row = node('label', 'facet')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = set.has(item.id)
        box.onchange = () => { box.checked ? set.add(item.id) : set.delete(item.id); refresh() }
        row.append(box, node('span', 'name', label(item)), node('span', 'n', counts(item)))
        row.dataset.search = `${label(item)} ${item.id}`.toLowerCase()
        return row
    }))
    $('channel-count').textContent = `${state.meta.channels.length}`
    $('author-count').textContent = `${state.meta.authors.length}`
}

const filterFacets = (input, container) => {
    const text = input.value.trim().toLowerCase()
    for (const row of container.children) row.hidden = Boolean(text) && !row.dataset.search.includes(text)
}

const renderList = () => {
    $('list').replaceChildren(...state.conversations.map(conversation => {
        const item = node('li')
        item.setAttribute('aria-selected', String(conversation.id === state.selected))
        const top = node('div', 'top')
        top.append(node('span', 'channel', `${conversation.channel.thread ? '↳ ' : ''}${conversation.channel.name}`), node('span', '', when(conversation.startedAt)))
        item.append(top, node('div', 'preview', conversation.turns[0].content.slice(0, 160)))
        const stats = node('div', 'top')
        stats.append(node('span', '', `${conversation.turns.length} turns`), node('span', '', `${conversation.participants} people`), node('span', '', `${conversation.chars} chars`))
        item.append(stats)
        item.onclick = () => { state.selected = conversation.id; renderList(); renderTranscript(conversation) }
        return item
    }))
}

const renderTranscript = conversation => {
    const container = $('transcript')
    const heading = node('h2', '', `${conversation.channel.thread ? '↳ ' : ''}${conversation.channel.name}`)
    const meta = node('p', 'meta', `${when(conversation.startedAt)} → ${when(conversation.endedAt)} · ${conversation.messages} messages · ${conversation.participants} people · ${conversation.chars} chars`)
    const turns = conversation.turns.map(turn => {
        const row = node('div', `turn ${turn.role}`)
        const who = node('div', 'who')
        who.append(node('span', '', turn.author.display_name), node('br'), node('span', '', when(turn.timestamp)))
        const bubble = node('div', 'bubble')
        bubble.append(node('span', 'role', turn.role), document.createTextNode(turn.content))
        row.append(who, bubble)
        return row
    })
    container.replaceChildren(heading, meta, ...turns)
}

const load = async (append = false) => {
    if (!append) state.offset = 0
    const response = await fetch(`/api/conversations?${params({ offset: String(state.offset), limit: String(state.limit) })}`)
    const data = await response.json()
    if (!response.ok) { $('count').textContent = data.error; return }
    state.total = data.total
    state.conversations = append ? [...state.conversations, ...data.conversations] : data.conversations
    state.offset = state.conversations.length
    $('count').textContent = `${data.total.toLocaleString()} conversations · ${data.stats.turns.toLocaleString()} turns`
    $('more').hidden = state.offset >= data.total
    renderList()
}

const refresh = () => { clearTimeout(pending); pending = setTimeout(() => { state.selected = null; load() }, 200) }

const loadMeta = async () => {
    const response = await fetch(`/api/meta${state.file ? `?file=${encodeURIComponent(state.file)}` : ''}`)
    const data = await response.json()
    if (!response.ok) { $('summary').textContent = data.error; return }
    state.meta = data
    state.file = data.file
    $('file').replaceChildren(...data.files.map(file => {
        const option = document.createElement('option')
        option.value = file.name
        option.textContent = `${file.name} (${file.messages.toLocaleString()})`
        return option
    }))
    $('file').value = data.file
    $('summary').textContent = `${data.messages.toLocaleString()} messages · ${data.channels.length} channels · ${data.from.slice(0, 10)} → ${data.to.slice(0, 10)}`
    facets(data.channels, $('channels'), state.channels, channel => channel.messages.toLocaleString(), channel => channel.category ? `${channel.category} / ${channel.name}` : channel.name)
    facets(data.authors, $('authors'), state.authors, author => author.messages.toLocaleString(), author => `${author.display_name}${author.bot ? ' (bot)' : ''}`)
    filterFacets($('channel-search'), $('channels'))
    filterFacets($('author-search'), $('authors'))
    $('export-stats').textContent = ''
    await load()
}

$('file').onchange = async event => {
    state.file = event.target.value
    state.channels.clear()
    state.authors.clear()
    await loadMeta()
}

for (const id of ['q', 'from', 'to', 'minTurns', 'minParticipants', 'minChars', 'maxChars', 'gap', 'attachments', 'includeBots', 'clean', 'dropUnanswered']) {
    $(id).oninput = refresh
}

$('channel-search').oninput = () => filterFacets($('channel-search'), $('channels'))
$('author-search').oninput = () => filterFacets($('author-search'), $('authors'))
$('sort').onchange = refresh
$('more').onclick = () => load(true)

$('reset').onclick = () => {
    for (const id of ['q', 'from', 'to', 'minChars', 'maxChars']) $(id).value = ''
    $('minTurns').value = 2
    $('minParticipants').value = 2
    $('gap').value = 30
    $('attachments').value = 'any'
    for (const id of ['includeBots', 'clean', 'dropUnanswered']) $(id).checked = true
    state.channels.clear()
    state.authors.clear()
    loadMeta()
}

const exportParams = () => {
    const search = params({ format: $('format').value, metadata: checked('metadata') ? '1' : '0' })
    const system = $('system').value.trim()
    if (system) search.set('system', system)
    return search
}

$('export-toggle').onclick = () => {
    $('export-stats').textContent = `${state.total.toLocaleString()} conversations match the current filters.`
    $('save-status').textContent = ''
    $('export').showModal()
}

$('download').onclick = () => { window.location.href = `/api/export?${exportParams()}` }

$('save').onclick = async () => {
    const status = $('save-status')
    status.textContent = 'saving…'
    const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: exportParams().toString(), name: $('name').value }),
    })
    const data = await response.json().catch(() => ({ error: `request failed (${response.status})` }))
    status.textContent = response.ok
        ? `saved ${data.lines.toLocaleString()} conversations (${data.stats.turns.toLocaleString()} turns, ${Math.round(data.bytes / 1024).toLocaleString()} KB) to ${data.file}`
        : `error: ${data.error}`
}

loadMeta()
