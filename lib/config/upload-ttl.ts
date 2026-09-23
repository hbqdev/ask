/**
 * UPLOAD_TTL_DAYS, parsed in ONE place.
 *
 * Default 0 = expiry disabled. The idle-upload sweep (expireIdleUploads in
 * lib/db/file-actions.ts) deletes user files, so it is opt-in: an unset, zero,
 * non-numeric or non-positive value is a no-op. Prod, staging and lab all set
 * 14 explicitly.
 *
 * There used to be two code defaults: the sweep read `?? 0` while the expiry
 * note shown to the model read `?? 14`, so with the variable unset the note
 * could name a TTL that was never in force.
 */
export function uploadTtlDays(): number {
  const n = Number(process.env.UPLOAD_TTL_DAYS ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
