// Legacy: old messages carry pasted material wrapped in <user-content> tags
// (new messages use `data-pastedContent` parts). Split it out so it renders
// as a collapsed card and the instruction stays the prominent text. Pure, so
// the web and the mobile app read old messages the same way.
const PASTED_RE = /<user-content>\n?([\s\S]*?)\n?<\/user-content>/g

export function splitPastedContent(content: string): {
  cards: string[]
  rest: string
} {
  const cards: string[] = []
  const rest = content
    .replace(PASTED_RE, (_, body: string) => {
      cards.push(body)
      return ''
    })
    .trim()
  return { cards, rest }
}
