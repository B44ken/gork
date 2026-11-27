// clod-text <text>: render text as big letters made of tiny clods ([ᴗ]), 3x5 font, one row of glyphs per word line.
import { defineCommand } from 'just-bash'

// Each glyph: 5 rows of 3 bits.
const font: Record<string, string> = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100111100111',
    F: '111100111100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
    K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
    P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
    Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
    '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
    '9': '111101111001110', ' ': '000000000000000', ',': '000000000010100', '.': '000000000000010', '!': '010010010000010',
    '?': '110001010000010', "'": '010010000000000', '-': '000000111000000', ':': '000010000010000',
}
const on = '[ᴗ]', off = '   '

export const render = (text: string) => text.toUpperCase().split(/\s+/).filter(Boolean).map(word =>
    [0, 1, 2, 3, 4].map(row => [...word].map(ch => {
        const bits = font[ch] ?? font['?']!
        return [0, 1, 2].map(col => bits[row * 3 + col] === '1' ? on : off).join('')
    }).join(' ').trimEnd()).join('\n')).join('\n\n')

export default () => defineCommand('clod-text', async args => {
    const text = args.join(' ')
    if (!text) return { stdout: '', stderr: 'usage: clod-text <text>\n', exitCode: 2 }
    return { stdout: render(text) + '\n', stderr: '', exitCode: 0 }
})
