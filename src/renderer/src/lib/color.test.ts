import { describe, expect, it } from 'vitest'
import { textOn } from './color'

describe('textOn', () => {
  it('uses black when neither white nor dark text reaches 4.5:1', () => {
    // Amethyst: white 4.12, dark 4.27.
    expect(textOn('#9E69AF')).toBe('#000000')
    // Eucalyptus: dark 4.49.
    expect(textOn('#009688')).toBe('#000000')
  })

  it('keeps white or dark text when one of them is enough', () => {
    expect(textOn('#039BE5')).toBe('#1f1f1f')
    expect(textOn('#0B8043')).toBe('#ffffff')
    expect(textOn('#F6BF26')).toBe('#1f1f1f')
  })
})
