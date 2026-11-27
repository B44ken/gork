import { expect, test } from 'bun:test'
import { render } from '../src/commands/clod-text.ts'

test('renders H', () => {
    expect(render('h').split('\n')[2]).toBe('[ᴗ][ᴗ][ᴗ]')
    expect(render('h').split('\n')).toHaveLength(5)
})
test('one block per word, comma kept', () => {
    const out = render('hello, world')
    expect(out.split('\n\n')).toHaveLength(2)
    expect(out.split('\n')[3]).toContain('[ᴗ]')
})
