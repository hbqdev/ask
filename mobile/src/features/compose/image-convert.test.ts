import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONVERT_FAILED_MESSAGE,
  JPEG_QUALITY,
  MAX_IMAGE_EDGE,
  toUploadable
} from '@/features/compose/image-convert'

type Bitmap = { width: number; height: number; close: () => void }

let bitmap: Bitmap
const createImageBitmap = vi.fn<(file: Blob) => Promise<Bitmap>>()
const drawImage = vi.fn()
/** Each canvas the code drew on, with the size it was given. */
const canvases: Array<{ width: number; height: number }> = []
let toBlobResult: (type: string) => Blob | null

beforeEach(() => {
  vi.clearAllMocks()
  canvases.length = 0
  bitmap = { width: 1000, height: 800, close: vi.fn() }
  createImageBitmap.mockImplementation(async () => bitmap)
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  toBlobResult = type => new Blob(['encoded'], { type })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      canvases.push(this)
      return { drawImage } as unknown as CanvasRenderingContext2D
    } as unknown as typeof HTMLCanvasElement.prototype.getContext
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
    (callback, type = 'image/png', quality) => {
      toBlobQuality = quality
      callback(toBlobResult(type))
    }
  )
})

let toBlobQuality: unknown

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const photo = (name: string, type: string) =>
  new File(['raw bytes'], name, { type })

describe('toUploadable', () => {
  it('converts HEIC to JPEG', async () => {
    const heic = photo('IMG_0001.HEIC', 'image/heic')
    const out = await toUploadable(heic)

    expect(createImageBitmap).toHaveBeenCalledWith(heic)
    expect(canvases[0]).toMatchObject({ width: 1000, height: 800 })
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1000, 800)
    expect(toBlobQuality).toBe(JPEG_QUALITY)
    expect(JPEG_QUALITY).toBe(0.9)
    expect(out).toBeInstanceOf(File)
    expect(out.name).toBe('IMG_0001.jpg')
    expect(out.type).toBe('image/jpeg')
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('knows HEIF, and HEIC by its extension when the type is missing', async () => {
    expect((await toUploadable(photo('a.heif', 'image/heif'))).name).toBe(
      'a.jpg'
    )
    expect((await toUploadable(photo('b.heic', ''))).type).toBe('image/jpeg')
    expect((await toUploadable(photo('c', 'image/heic-sequence'))).name).toBe(
      'c.jpg'
    )
  })

  it('scales an image over the size limit down to it, keeping the format', async () => {
    bitmap = { width: 8000, height: 6000, close: vi.fn() }
    const out = await toUploadable(photo('big.jpg', 'image/jpeg'))

    expect(MAX_IMAGE_EDGE).toBe(4096)
    expect(canvases[0]).toMatchObject({ width: 4096, height: 3072 })
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 4096, 3072)
    expect(out.name).toBe('big.jpg')
    expect(out.type).toBe('image/jpeg')
  })

  it('scales a tall PNG by its long edge and keeps it PNG', async () => {
    bitmap = { width: 2000, height: 10000, close: vi.fn() }
    const out = await toUploadable(photo('scan.png', 'image/png'))

    expect(canvases[0]).toMatchObject({ width: 819, height: 4096 })
    expect(out.name).toBe('scan.png')
    expect(out.type).toBe('image/png')
  })

  it('returns an image within the limit unchanged', async () => {
    bitmap = { width: 4096, height: 4096, close: vi.fn() }
    const small = photo('ok.webp', 'image/webp')

    expect(await toUploadable(small)).toBe(small)
    expect(canvases).toHaveLength(0)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('passes non-images, and images it would not re-encode, through untouched', async () => {
    const pdf = photo('doc.pdf', 'application/pdf')
    const gif = photo('loop.gif', 'image/gif')

    expect(await toUploadable(pdf)).toBe(pdf)
    expect(await toUploadable(gif)).toBe(gif)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('uploads an image it cannot decode as it is', async () => {
    createImageBitmap.mockRejectedValue(new Error('decode failed'))
    const odd = photo('odd.jpg', 'image/jpeg')
    expect(await toUploadable(odd)).toBe(odd)
  })

  it('fails a HEIC photo it cannot decode, since the server refuses HEIC', async () => {
    createImageBitmap.mockRejectedValue(new Error('decode failed'))
    await expect(toUploadable(photo('a.heic', 'image/heic'))).rejects.toThrow(
      CONVERT_FAILED_MESSAGE
    )
  })

  it('fails when the canvas cannot encode, closing the bitmap', async () => {
    toBlobResult = () => null
    await expect(toUploadable(photo('a.heic', 'image/heic'))).rejects.toThrow(
      CONVERT_FAILED_MESSAGE
    )
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('uploads a large image as it is when it cannot be scaled', async () => {
    bitmap = { width: 8000, height: 6000, close: vi.fn() }
    toBlobResult = () => null
    const big = photo('big.jpg', 'image/jpeg')
    expect(await toUploadable(big)).toBe(big)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('names a scaled WebP as the JPEG it becomes', async () => {
    bitmap = { width: 5000, height: 100, close: vi.fn() }
    const out = await toUploadable(photo('wide.webp', 'image/webp'))
    expect(out.name).toBe('wide.jpg')
    expect(out.type).toBe('image/jpeg')
  })

  it('fails when there is no 2D canvas', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    await expect(toUploadable(photo('a.heic', 'image/heic'))).rejects.toThrow(
      CONVERT_FAILED_MESSAGE
    )
  })
})
