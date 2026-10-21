// Follow-up questions the answer suggests. A tap asks one; while a turn is
// streaming they are disabled, as the web rejects submitQuery then.

export type RelatedQuestionsProps = {
  queries: string[]
  disabled: boolean
  onAsk: (query: string) => void
}

export function RelatedQuestions({
  queries,
  disabled,
  onAsk
}: RelatedQuestionsProps) {
  if (queries.length === 0) return null
  return (
    <section>
      <h3 className="pb-1 text-sm font-semibold">Related</h3>
      <ul className="divide-y divide-foreground/10">
        {queries.map(query => (
          <li key={query}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAsk(query)}
              className="flex min-h-11 w-full touch-manipulation items-center py-2 text-left text-[0.95rem] text-foreground/80 active:opacity-50 disabled:opacity-40"
            >
              {query}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
