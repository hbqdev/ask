import { registerOTel } from '@vercel/otel'
import { LangfuseExporter } from 'langfuse-vercel'

export async function register() {
  registerOTel({
    serviceName: 'ask-ai-search',
    traceExporter: new LangfuseExporter()
  })

  // Initialize Ollama validation on server startup (only when configured)
  if (process.env.OLLAMA_BASE_URL) {
    const { initializeOllamaValidation } = await import(
      '@/lib/config/ollama-validator'
    )
    await initializeOllamaValidation().catch(err => {
      console.error('Failed to initialize Ollama validation:', err)
    })
  }

  // Schedule periodic cleanup of uploaded files older than 3 days.
  // Only run in the Node.js runtime (not edge), and only when uploads are enabled.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { scheduleUploadCleanup } = await import('@/lib/utils/upload-cleanup')
    scheduleUploadCleanup()
  }
}
