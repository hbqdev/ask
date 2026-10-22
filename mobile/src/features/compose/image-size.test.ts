import { describe, expect, it } from 'vitest'

import { imageSize } from '@/features/compose/image-size'

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(
    parts.flatMap(part =>
      typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part
    )
  )
const be16 = (n: number) => [n >> 8, n & 0xff]
const be32 = (n: number) => [
  n >>> 24,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff
]
const le16 = (n: number) => [n & 0xff, n >> 8]
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]

/** A JPEG's start: SOI, the given segments, then a baseline SOF0. */
const jpeg = (width: number, height: number, segments: number[][] = []) =>
  bytes([0xff, 0xd8], ...segments, [
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3
  ])
/** An APPn segment carrying `size` bytes of payload. */
const app = (n: number, size: number) => [
  0xff,
  0xe0 + n,
  ...be16(size + 2),
  ...new Array<number>(size).fill(0)
]

describe('imageSize', () => {
  it('reads a PNG from its IHDR', () => {
    const png = bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      be32(13),
      'IHDR',
      be32(5000),
      be32(300)
    )
    expect(imageSize(png)).toEqual({ width: 5000, height: 300 })
  })

  it('reads a JPEG from its frame header, past EXIF and other segments', () => {
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(
      imageSize(jpeg(8064, 6048, [app(1, 30_000), app(2, 600), [0xff, 0xff]]))
    ).toEqual({ width: 8064, height: 6048 })
  })

  it('reads progressive and other frame types, skipping standalone markers', () => {
    const progressive = bytes(
      [0xff, 0xd8],
      [0xff, 0xd0],
      [0xff, 0xc2, ...be16(17), 8, ...be16(10), ...be16(20), 3]
    )
    expect(imageSize(progressive)).toEqual({ width: 20, height: 10 })
  })

  it('does not take a DHT or DAC segment (C4, CC) for a frame header', () => {
    const dht = [0xff, 0xc4, ...be16(7), 0, 0, 0, 0, 0]
    expect(imageSize(jpeg(30, 40, [dht]))).toEqual({ width: 30, height: 40 })
    const dac = [0xff, 0xcc, ...be16(4), 0, 0]
    expect(imageSize(jpeg(30, 40, [dac]))).toEqual({ width: 30, height: 40 })
  })

  it('gives up on a JPEG whose frame header is not in the bytes read', () => {
    expect(imageSize(bytes([0xff, 0xd8], app(1, 100)))).toBeNull()
    expect(imageSize(jpeg(10, 10).slice(0, -3))).toBeNull()
    // Image data (SOS) before any frame header.
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
    expect(imageSize(bytes([0xff, 0xd8, 0x00, 0x00]))).toBeNull()
  })

  it('reads lossy (VP8), lossless (VP8L) and extended (VP8X) WebP', () => {
    const riff = (chunk: string, body: number[]) =>
      bytes('RIFF', be32(0), 'WEBP', chunk, le16(body.length), [0, 0], body)
    expect(
      imageSize(
        riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)])
      )
    ).toEqual({ width: 640, height: 480 })

    // 14 bits each of width-1 and height-1 after the 0x2f signature.
    const w = 5000 - 1
    const h = 300 - 1
    const bits = w | (h << 14)
    expect(
      imageSize(
        riff('VP8L', [
          0x2f,
          bits & 0xff,
          (bits >> 8) & 0xff,
          (bits >> 16) & 0xff,
          (bits >>> 24) & 0xff
        ])
      )
    ).toEqual({ width: 5000, height: 300 })

    expect(
      imageSize(riff('VP8X', [0, 0, 0, 0, ...le24(8191), ...le24(99)]))
    ).toEqual({ width: 8192, height: 100 })
  })

  it('gives up on a WebP it cannot read', () => {
    const riff = (chunk: string, body: number[]) =>
      bytes('RIFF', be32(0), 'WEBP', chunk, le16(body.length), [0, 0], body)
    expect(imageSize(riff('VP8 ', [0, 0, 0, 1, 2, 3, 0, 0, 0, 0]))).toBeNull()
    expect(imageSize(riff('VP8L', [0x00, 0, 0, 0, 0]))).toBeNull()
    expect(imageSize(riff('ALPH', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(imageSize(bytes('RIFF', be32(0), 'WEBP', 'VP8X'))).toBeNull()
  })

  it('gives up on anything else, and on a zero size', () => {
    expect(imageSize(bytes('raw bytes'))).toBeNull()
    expect(imageSize(new Uint8Array())).toBeNull()
    expect(imageSize(jpeg(0, 10))).toBeNull()
  })
})
