import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
const TTL_DAYS = parseInt(process.env.UPLOAD_TTL_DAYS || '3', 10)
const INTERVAL_MS = 24 * 60 * 60 * 1000 // run once per day

async function runCleanup() {
  try {
    // Delete files older than TTL_DAYS days
    await execFileAsync('find', [
      UPLOADS_DIR,
      '-type', 'f',
      '-mtime', `+${TTL_DAYS}`,
      '-delete'
    ])
    // Remove empty directories left behind (but not UPLOADS_DIR itself)
    await execFileAsync('find', [
      UPLOADS_DIR,
      '-mindepth', '1',
      '-type', 'd',
      '-empty',
      '-delete'
    ])
    console.log(`[upload-cleanup] Removed uploads older than ${TTL_DAYS} days`)
  } catch (err: any) {
    // Non-fatal: log and continue. The directory may not exist yet.
    if (err?.code !== 'ENOENT') {
      console.error('[upload-cleanup] Cleanup error (non-fatal):', err?.message)
    }
  }
}

export function scheduleUploadCleanup() {
  // Run immediately on startup, then once every 24 hours
  runCleanup()
  setInterval(runCleanup, INTERVAL_MS)
}
