// Makes a picked photo fit to upload. Ask refuses HEIC (its allowlist has no
// .heic), so a HEIC/HEIF photo is decoded and re-encoded as a JPEG. A photo
// larger than MAX_IMAGE_EDGE on its long edge is scaled down to it, which also
// keeps the canvas inside iOS's size limit. Everything else goes as picked.

/** The longest edge, in px, an uploaded image keeps. */
export const MAX_IMAGE_EDGE = 4096
export const JPEG_QUALITY = 0.9
export const CONVERT_FAILED_MESSAGE = "Couldn't convert this photo"

/** Formats the canvas can re-encode; a GIF would lose its animation. */
const SCALABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** A HEIC/HEIF photo, by its type or by its name. */
export const isHeic = (file: File) =>
  /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)

/** The name with its extension (if any) replaced by `ext`. */
const renameTo = (name: string, ext: string) =>
  `${name.replace(/\.[^./]*$/, '')}.${ext}`

function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: string
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return Promise.reject(new Error(CONVERT_FAILED_MESSAGE))
  context.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob =>
        blob ? resolve(blob) : reject(new Error(CONVERT_FAILED_MESSAGE)),
      type,
      JPEG_QUALITY
    )
  )
}

/**
 * The file to upload for `file`: a JPEG for a HEIC photo, a scaled copy of an
 * oversized image, or `file` itself. Rejects only for a HEIC photo it cannot
 * convert; any other image it cannot process goes as it is.
 */
export async function toUploadable(file: File): Promise<File> {
  const heic = isHeic(file)
  if (!heic && !SCALABLE_TYPES.has(file.type)) return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    if (heic) throw new Error(CONVERT_FAILED_MESSAGE)
    return file
  }

  try {
    const scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height)
    )
    if (!heic && scale === 1) return file
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    // PNG keeps its transparency; the rest become JPEG.
    const type = !heic && file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await encode(bitmap, width, height, type)
    const name = type === file.type ? file.name : renameTo(file.name, 'jpg')
    return new File([blob], name, { type, lastModified: file.lastModified })
  } catch (err) {
    if (heic) throw err
    return file
  } finally {
    bitmap.close()
  }
}
