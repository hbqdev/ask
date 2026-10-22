// Discover thumbnails come from the news engines as remote URLs. Bing News
// ones carry tracking/size params; only `id` identifies the image, so keep
// just that. Everything else (and anything unparseable) is used as it is.
// Pure: shared by the web Discover page and the mobile app.
export function thumbUrl(raw: string): string {
  try {
    const u = new URL(raw)
    // Bing News thumbnails use ?id= as the only meaningful param — strip the rest
    if (u.hostname.includes('bing.com') && u.searchParams.has('id')) {
      return `${u.origin}${u.pathname}?id=${u.searchParams.get('id')}`
    }
    // Google News and all other engines: use URL as-is
    return raw
  } catch {
    return raw
  }
}
