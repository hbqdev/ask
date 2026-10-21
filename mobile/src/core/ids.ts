import { createId } from '@paralleldrive/cuid2'

/** A new chat or message id: a cuid2, generated client-side like the web's. */
export function newId(): string {
  return createId()
}
