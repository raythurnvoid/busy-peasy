// Finds a Teams, Meet or Zoom link in free text or HTML (location, body, description).
const JOIN_URL =
  /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/|teams\.live\.com\/meet\/|meet\.google\.com\/[a-z]+-|[\w-]+\.zoom\.us\/j\/|zoom\.us\/j\/)[^\s"'<>]*/i

export function findJoinUrl(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    const match = text?.match(JOIN_URL)
    if (match) return match[0].replace(/&amp;/g, '&')
  }
  return null
}
