// An image's pixel size read from the first bytes of its file, without
// decoding it: the frame header of a JPEG, the IHDR of a PNG, the VP8/VP8L/
// VP8X header of a WebP. Null when the bytes are none of these, or the header
// is not within them.

export type ImageSize = { width: number; height: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length))
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const be32 = (b: Uint8Array, at: number) =>
  be16(b, at) * 0x10000 + be16(b, at + 2)
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const le24 = (b: Uint8Array, at: number) => le16(b, at) | (b[at + 2] << 16)

/** A size, unless the header ran past the bytes or says zero. */
const sized = (width: number, height: number): ImageSize | null =>
  width > 0 && height > 0 ? { width, height } : null

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  return sized(be32(b, 16), be32(b, 20))
}

/** Start-of-frame markers: C0–CF but DHT (C4), JPG (C8) and DAC (CC). */
const isFrame = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc

function jpeg(b: Uint8Array): ImageSize | null {
  let at = 2
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++
      continue
    }
    // Restart markers and TEM carry no length.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    // Image data or the end before any frame header.
    if (marker === 0xda || marker === 0xd9) return null
    if (isFrame(marker)) {
      if (at + 9 > b.length) return null
      return sized(be16(b, at + 7), be16(b, at + 5))
    }
    at += 2 + be16(b, at + 2)
  }
  return null
}

function webp(b: Uint8Array): ImageSize | null {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = (le16(b, 21) | (le16(b, 23) << 16)) >>> 0
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X') {
    if (b.length < 30) return null
    return sized(le24(b, 24) + 1, le24(b, 27) + 1)
  }
  return null
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return png(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes)
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return webp(bytes)
  }
  return null
}
