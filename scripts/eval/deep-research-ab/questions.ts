// Curated question set for the deep-research A/B.
//
// These are deliberately NOT simple factual lookups (a single-agent turn nails
// those, and multi-agent depth can't show up where there's nothing to go deep
// on). Every question is multi-faceted — a comparison, a synthesis of
// conflicting evidence, or a "map the landscape" ask — where a good answer has
// to cover several distinct angles AND go deep on each. That is exactly the
// shape where a planner + parallel sub-agents should, if the idea holds, beat
// one agent doing "search 15 times and write a report". Domains are varied so a
// win isn't an artifact of one subject area.

export interface DeepResearchQuestion {
  id: string
  domain: string
  text: string
  /** Why this question is genuinely deep-research-worthy (not a lookup). */
  note: string
}

export const DEEP_RESEARCH_QUESTIONS: DeepResearchQuestion[] = [
  {
    id: 'grid-storage',
    domain: 'energy',
    text: 'Compare grid-scale battery storage chemistries (LFP, NMC, sodium-ion, and flow batteries) for a utility deploying in 2026 — on cost per kWh, cycle life, safety, and supply-chain risk. Which chemistry fits which use case?',
    note: 'Four technologies scored across four independent axes, then mapped to use cases — a decomposable comparison where each angle needs its own sourcing and shallow coverage of any axis is obvious.'
  },
  {
    id: 'agent-memory',
    domain: 'ai-infrastructure',
    text: 'What are the current approaches to giving LLM agents long-term memory (vector RAG, knowledge graphs, context compression, and periodic fine-tuning), how do they trade off against each other, and where is each one failing in practice as of 2026?',
    note: 'A fast-moving landscape question: needs an inventory of distinct approaches plus their real-world failure modes — breadth of methods and depth on each, not a one-paragraph definition.'
  },
  {
    id: 'time-restricted-eating',
    domain: 'health-science',
    text: 'What does the current clinical evidence say about time-restricted eating for metabolic health — where do the trials agree, where do they conflict, and what confounds the results?',
    note: 'Evidence synthesis with genuine disagreement in the literature; a strong answer must surface conflicting trials and their confounds, which rewards pulling from multiple independent studies.'
  },
  {
    id: 'carbon-border',
    domain: 'economics-policy',
    text: 'How are different jurisdictions structuring carbon border adjustment mechanisms (the EU CBAM and its emerging counterparts), what compliance costs do exporters face, and what WTO or retaliation tensions have surfaced?',
    note: 'Multi-jurisdiction policy landscape with second-order effects (compliance cost, trade retaliation) — coverage across regions and depth on consequences both matter.'
  },
  {
    id: 'crispr-delivery',
    domain: 'biotech',
    text: 'Compare the leading CRISPR delivery methods for in-vivo therapy (lipid nanoparticles, AAV vectors, and virus-like particles) on editing efficiency, immunogenicity, tissue targeting, and clinical progress.',
    note: 'A technical comparison across several distinct performance axes where the state of the art shifts by tissue and by trial — specificity (numbers, named programs) separates a deep answer from a vague one.'
  },
  {
    id: 'congestion-pricing',
    domain: 'urban-policy',
    text: 'What has actually happened in cities that implemented congestion pricing (London, Stockholm, Singapore, New York) — the measured effects on traffic, revenue, equity, and public opinion — and why do the results differ between them?',
    note: 'Comparative case synthesis: four cities, four outcome dimensions, plus a causal "why do they differ" that only holds up if each case is researched concretely rather than generalized.'
  },
  {
    id: 'stablecoin-reg',
    domain: 'finance-regulation',
    text: 'What is the state of the stablecoin regulatory landscape across the US, the EU (MiCA), and major Asian markets in 2026, and how are the largest issuers adapting their reserve and disclosure practices in response?',
    note: 'Recency-sensitive, multi-jurisdiction regulatory map tied to concrete issuer behavior — needs current sources per region and depth on how rules translate into practice.'
  },
  {
    id: 'low-carbon-materials',
    domain: 'industrial-decarbonization',
    text: 'What are the viable paths to lower-carbon cement and steel at industrial scale (hydrogen direct reduction, electrolysis, carbon capture, and alternative binders), and what cost and technology-readiness gaps are blocking each one?',
    note: 'Two hard-to-abate sectors and several competing pathways, each with distinct cost/readiness barriers — a decomposition-friendly question where breadth without depth on the gaps is useless.'
  },
  {
    id: 'alignment-methods',
    domain: 'machine-learning',
    text: 'How do the main post-training alignment methods (RLHF, DPO, constitutional AI / RLAIF, and process reward models) compare on cost, data requirements, failure modes, and the kinds of behavior they actually improve?',
    note: 'A methods comparison across four axes where the interesting content is the trade-offs and failure modes — surface familiarity is easy, real depth on when each wins is not.'
  },
  {
    id: 'regen-agriculture',
    domain: 'ecology-agriculture',
    text: 'What does the research show about regenerative agriculture’s actual carbon-sequestration potential — how large is it, how durable, how is it measured, and where are the strongest scientific critiques?',
    note: 'Contested evidence with a strong critical literature; a good answer must quantify, address permanence and measurement, and steelman the critiques — synthesis across disagreeing sources.'
  }
]
