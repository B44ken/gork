const $ = id => document.getElementById(id)
// Each instance is mounted under its own path, so every API call is relative to this page.
const root = location.pathname.replace(/\/+$/, '')
let csrf = ''

async function api(path, data) {
    const options = data === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(data),
    }
    const response = await fetch(root + path, options)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    return body
}

async function run(path, data) {
    try {
        const { result } = await api(path, data)
        await refresh()
        $('status').textContent = typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
        $('status').textContent = error.message
    }
}

function renderSettings(settings) {
    $('config').replaceChildren(...settings.map(({ key, value, choices, type, min, max, multiline }) => {
        const form = document.createElement('form')
        const label = document.createElement('label')
        const input = document.createElement(choices ? 'select' : multiline ? 'textarea' : 'input')
        if (multiline) input.rows = 8
        const button = document.createElement('button')
        label.textContent = key + ' '
        if (choices) {
            for (const choice of choices) input.add(new Option(choice, choice))
        } else if (type !== 'string') {
            input.type = 'number'
            input.step = type === 'integer' ? '1' : 'any'
            input.min = min
            if (max !== undefined) input.max = max
        }
        input.value = value
        input.required = true
        button.textContent = 'Save'
        label.append(input)
        form.append(label, button)
        form.onsubmit = event => {
            event.preventDefault()
            run('/api/config', { key, value: input.value })
        }
        return form
    }))
}

function renderUsers(users) {
    for (const form of [$('addMemory'), $('blacklistForm')]) {
        const select = form.elements.userId, selected = select.value
        select.replaceChildren(new Option('Choose a user', ''), ...users.map(user => new Option(user.username, user.id)))
        select.value = selected
    }
}

function renderMemories(facts, users) {
    const usernames = new Map(users.map(user => [user.id, user.username]))
    $('memories').replaceChildren(...Object.entries(facts).map(([userId, facts]) => {
        const username = usernames.get(userId)
        const div = document.createElement('div')
        const heading = document.createElement('h3')
        heading.textContent = username
        div.append(heading)
        facts.forEach((fact, index) => {
            const row = document.createElement('p'), button = document.createElement('button')
            button.textContent = 'Delete'
            button.onclick = () => run('/api/memory/delete', { userId, number: index + 1 })
            row.append(document.createTextNode(fact + ' '), button)
            div.append(row)
        })
        const clear = document.createElement('button')
        clear.textContent = 'Clear user memories'
        clear.onclick = () => {
            if (confirm('Clear all memories for ' + username + '?')) run('/api/memory/clear', { userId })
        }
        div.append(clear)
        return div
    }))
}

function renderTimeouts(timeouts) {
    $('timeouts').replaceChildren(...timeouts.map(({ userId, username, reason, expiresAt }) => {
        const row = document.createElement('p'), clear = document.createElement('button')
        clear.textContent = 'Clear timeout'
        clear.onclick = () => run('/api/timeouts/remove', { userId })
        row.append(document.createTextNode(`${username}: ${reason} · expires ${new Date(expiresAt).toLocaleTimeString()} `), clear)
        return row
    }))
    if (!timeouts.length) $('timeouts').textContent = 'No active timeouts'
}

async function refresh() {
    const state = await api('/api/state')
    csrf = state.csrf
    document.title = state.name + ' dashboard'
    $('instance').textContent = state.name + ' dashboard'
    $('persona').elements.content.value = state.persona
    $('persona').elements.content.maxLength = state.personaMaxLength
    $('blacklist').textContent = state.blacklist.map(user => user.username).join('\n') || 'blacklist is empty'
    const moderation = $('moderation').elements
    moderation.enabled.checked = state.config.moderation.enabled
    moderation.timeout_seconds.value = state.config.moderation.timeout_seconds
    moderation.policy.value = state.config.moderation.policy
    renderSettings(state.settings)
    renderUsers(state.users)
    renderMemories(state.facts, state.users)
    renderTimeouts(state.timeouts)
}

$('persona').onsubmit = event => {
    event.preventDefault()
    run('/api/persona', { content: event.target.elements.content.value })
}
$('moderation').onsubmit = event => {
    event.preventDefault()
    const fields = event.target.elements
    run('/api/moderation', {
        enabled: fields.enabled.checked,
        timeout_seconds: Number(fields.timeout_seconds.value),
        policy: fields.policy.value,
    })
}
$('refreshTimeouts').onclick = async () => {
    try {
        renderTimeouts((await api('/api/state')).timeouts)
    } catch (error) {
        $('status').textContent = error.message
    }
}
$('resetPersona').onclick = () => {
    if (confirm('Reset persona?')) run('/api/persona/reset', {})
}
$('addMemory').onsubmit = event => {
    event.preventDefault()
    run('/api/memory/add', Object.fromEntries(new FormData(event.target)))
}
$('clearAll').onclick = () => {
    if (confirm('Clear every user’s memories?')) run('/api/memory/clear', {})
}
$('blacklistForm').onsubmit = event => {
    event.preventDefault()
    run('/api/blacklist/' + event.submitter.value, { userId: event.target.elements.userId.value })
}
$('usage').onsubmit = async event => {
    event.preventDefault()
    const fields = event.target.elements
    try {
        const { result } = await api('/api/usage', {
            group_by: fields.group_by.value,
            last_minutes: fields.last_minutes.value ? Number(fields.last_minutes.value) : null,
            start_date: null, end_date: null,
        })
        $('usageResult').textContent = JSON.stringify(result, null, 2)
    } catch (error) {
        $('status').textContent = error.message
    }
}
refresh().catch(error => { $('status').textContent = error.message })
