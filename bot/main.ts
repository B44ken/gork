import * as bot from './bot.ts'
import * as ai from './ai.ts'
import * as memory from './memory.ts'
import Exa from "exa-js"
const exa = new Exa(process.env.EXA_API_KEY)

ai.tool('web-search', 'search a question via exa', ['query'], async ({ query }) => (await exa.search(query, { contents: { highlights: { maxCharacters: 2500 } } })).results)
ai.tool('add-fun-fact', 'adds to memory', ['user', 'fact'], memory.addFact)
ai.tool('delete-fun-fact', 'deletes from memory', ['user', 'fact'], memory.deleteFact)

bot.command('lobotomize', {  }, async () => 'the operation was a success:)')
bot.command('gork config', {
    key: bot.oneOf(bot.string, ['context', 'thinking', 'waffle.chance', 'waffle.after_msgs']),
    value: bot.string,
}, async (_, args) =>
    memory.setConfig({ key: String(args.key), value: String(args.value) }))

bot.message(async ({ channel, history, next }) => {
    let sys = 'you are gork jr, a helpful, somewhat brainrotted, assistant.'
    if(channel == 'degeneracy') sys += 'you are extremely degenerate and horny.'
    if(channel == 'general') sys += ' your messages must be brief.'
    sys += 'facts you know about these users:' + memory.buildFacts('gork', ...history.map(h => h.name), next.name)

    return (await ai.get(sys, history, next)).slice(0, 1990)
})

bot.ready()