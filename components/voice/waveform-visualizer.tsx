'use client'
import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils'

// Live audio-level bars driven off a MediaStream via a Web Audio AnalyserNode +
// requestAnimationFrame. Self-contained: owns its AudioContext and tears the
// whole graph down when the stream changes or the component unmounts. Purely
// decorative (aria-hidden); the bars scaleY between a small floor and 1.
export function WaveformVisualizer({
  stream,
  bars = 28,
  className
}: {
  stream: MediaStream | null
  bars?: number
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!stream) return
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioCtx) return

    const ctx = new AudioCtx()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.7
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const barEls = Array.from(
      containerRef.current?.children ?? []
    ) as HTMLElement[]
    let raf = 0

    const tick = () => {
      analyser.getByteFrequencyData(data)
      const n = barEls.length
      for (let i = 0; i < n; i++) {
        // Sample across the spectrum; keep a floor so it always reads as "live".
        const v = data[Math.floor((i / n) * data.length)] / 255
        barEls[i].style.transform = `scaleY(${Math.max(0.12, v)})`
      }
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      source.disconnect()
      analyser.disconnect()
      void ctx.close()
    }
  }, [stream])

  return (
    <div
      ref={containerRef}
      className={cn('flex h-5 items-center gap-[2px]', className)}
      aria-hidden
    >
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="h-full w-[3px] rounded-full bg-current"
          style={{ transform: 'scaleY(0.12)', transformOrigin: 'center' }}
        />
      ))}
    </div>
  )
}
