import { S3Client } from '@aws-sdk/client-s3'

export const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'user-uploads'
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || ''

let _r2Client: S3Client | null = null

export function getR2Client(): S3Client {
  if (_r2Client) {
    return _r2Client
  }

  const s3Endpoint = process.env.S3_ENDPOINT?.replace(/\/+$/, '')
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 configuration missing: R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY'
    )
  }

  if (!s3Endpoint && !accountId) {
    throw new Error(
      'S3 configuration missing: set S3_ENDPOINT (generic S3) or R2_ACCOUNT_ID (Cloudflare R2)'
    )
  }

  _r2Client = new S3Client({
    region: 'auto',
    endpoint: s3Endpoint || `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: !!s3Endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  })

  return _r2Client
}
