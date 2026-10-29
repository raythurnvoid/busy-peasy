// Picks dark or white text, whichever has more contrast on the given background (#RRGGBB).
// Black when neither reaches 4.5:1 (mid colors like Amethyst), so text always passes WCAG AA.
export function textOn(hex: string): string {
  const luminance = relativeLuminance(hex)
  const onWhite = 1.05 / (luminance + 0.05)
  const onDark = (luminance + 0.05) / (relativeLuminance('#1f1f1f') + 0.05)
  if (onWhite < 4.5 && onDark < 4.5) return '#000000'
  return onWhite >= onDark ? '#ffffff' : '#1f1f1f'
}

function relativeLuminance(hex: string): number {
  const value = parseInt(hex.slice(1, 7), 16)
  const channel = (shift: number): number => {
    const c = ((value >> shift) & 255) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}
