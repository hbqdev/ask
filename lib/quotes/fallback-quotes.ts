import type { Quote } from './types'

/**
 * Shipped in-repo so the waiting indicator still has something to show when
 * Couchbase and Redis are both unavailable. Kept deliberately short — this is
 * a safety net, not the real library.
 */
export const FALLBACK_QUOTES: Quote[] = [
  { q: 'We are made of star-stuff.', a: 'Carl Sagan' },
  {
    q: 'Somewhere, something incredible is waiting to be known.',
    a: 'Carl Sagan'
  },
  {
    q: 'The universe is under no obligation to make sense to you.',
    a: 'Neil deGrasse Tyson'
  },
  {
    q: 'Any sufficiently advanced technology is indistinguishable from magic.',
    a: 'Arthur C. Clarke'
  },
  {
    q: 'I have no special talent. I am only passionately curious.',
    a: 'Albert Einstein'
  },
  {
    q: 'Science gathers knowledge faster than society gathers wisdom.',
    a: 'Isaac Asimov'
  },
  {
    q: 'The good thing about science is that it is true whether or not you believe in it.',
    a: 'Neil deGrasse Tyson'
  },
  {
    q: 'Nothing in life is to be feared, it is only to be understood.',
    a: 'Marie Curie'
  },
  {
    q: 'The important thing is not to stop questioning.',
    a: 'Albert Einstein'
  },
  {
    q: 'Equipped with his five senses, man explores the universe around him.',
    a: 'Edwin Hubble'
  },
  {
    q: 'Research is what I am doing when I do not know what I am doing.',
    a: 'Wernher von Braun'
  },
  {
    q: 'If I have seen further it is by standing on the shoulders of giants.',
    a: 'Isaac Newton'
  },
  {
    q: 'What we know is a drop, what we do not know is an ocean.',
    a: 'Isaac Newton'
  },
  { q: 'Simplicity is the ultimate sophistication.', a: 'Leonardo da Vinci' },
  {
    q: 'The cure for boredom is curiosity. There is no cure for curiosity.',
    a: 'Dorothy Parker'
  },
  {
    q: 'Everything should be made as simple as possible, but not simpler.',
    a: 'Albert Einstein'
  },
  {
    q: 'An expert is a person who has made all the mistakes in a narrow field.',
    a: 'Niels Bohr'
  },
  { q: 'Somewhere, something incredible is being ignored.', a: 'Anonymous' },
  { q: 'The best way to predict the future is to invent it.', a: 'Alan Kay' },
  { q: 'Premature optimization is the root of all evil.', a: 'Donald Knuth' },
  { q: 'Any fool can know. The point is to understand.', a: 'Albert Einstein' },
  { q: 'Truth is ever to be found in simplicity.', a: 'Isaac Newton' }
]
