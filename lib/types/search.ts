// Search mode type definition
export type SearchMode = 'quick' | 'adaptive'

// Focus mode: controls which sources are searched
// 'auto' = model decides based on query
// 'academic' = force scholarly sources (Google Scholar, arXiv, PubMed)
// 'discussions' = force community sources (Reddit)
export type FocusMode = 'auto' | 'academic' | 'discussions'
