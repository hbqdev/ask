#!/usr/bin/env bash
# Sample GPU power state every 5 minutes so we can see the REAL idle duty cycle
# now that ask-keep-warm is disabled (demand-warm only).
#
# Sampled sparsely on purpose: polling nvidia-smi every few seconds can itself
# keep a GPU out of P8, which would bias the very thing we're measuring.
set -u
OUT="${1:-/home/nightfury/logs/gpu-idle.log}"
while true; do
  for h in 192.168.50.171 192.168.50.160 192.168.50.17; do
    s=$(timeout 12 ssh -o ConnectTimeout=8 -o BatchMode=yes "$h" \
      "/usr/lib/wsl/lib/nvidia-smi --query-gpu=name,pstate,clocks.sm,power.draw --format=csv,noheader" 2>/dev/null | head -1)
    [ -n "$s" ] && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $h $s" >> "$OUT"
  done
  tail -n 5000 "$OUT" > "$OUT.tmp" 2>/dev/null && mv "$OUT.tmp" "$OUT"
  sleep 300
done
