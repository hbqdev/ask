// Single source of truth for the upload allowlist, shared by the server route
// (app/api/upload/route.ts) and the client picker (components/file-upload-button.tsx)
// so the two can never drift. Broad allowlist: office docs, media, code, and
// text formats. Extension is checked IN ADDITION to media type because
// browsers/clients frequently send generic or incorrect content-types (e.g.
// `application/octet-stream` for code files) — requiring both keeps this from
// being a wildcard filter.

export const ALLOWED_MEDIA_PREFIXES = ['image/', 'audio/', 'video/', 'text/']

export const ALLOWED_EXACT_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/epub+zip',
  'application/octet-stream' // code files; gated by extension
])

// Order here defines ACCEPT_ATTRIBUTE's order (see below). `htm` sits next to
// `html` — it is a text extension in upload-rag's TEXT_EXTENSIONS, so it must
// be accepted here too (it was previously missing, wrongly rejecting .htm).
export const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'txt',
  'md',
  'html',
  'htm',
  'epub',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'flac',
  'mp4',
  'mkv',
  'webm',
  'mov',
  'ts',
  'js',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'json',
  'yaml',
  'yml',
  'toml'
])

// The `<input accept="...">` string for the file picker, derived from the
// extension allowlist so it can never drift from it.
export const ACCEPT_ATTRIBUTE = Array.from(ALLOWED_EXTENSIONS)
  .map(ext => `.${ext}`)
  .join(',')

// A file passes if its extension is allowed AND its media type is in an
// allowed exact/family set. Both the server route and the client picker call
// this so their decisions are identical.
export function isAllowedUpload(mediaType: string, filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.has(ext)) return false
  return (
    ALLOWED_EXACT_TYPES.has(mediaType) ||
    ALLOWED_MEDIA_PREFIXES.some(p => mediaType.startsWith(p))
  )
}
