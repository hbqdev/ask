#!/usr/bin/env bash
# Evict model weight files from the Linux page cache on NightFuryX.
#
# Each GPU service reads its weights from disk once at start-up and copies them
# to the GPU; Linux keeps the copy it read as page cache. Those pages are never
# read again, but under WSL the cached copy stays charged to the WSL VM
# (vmmemWSL) and Windows can't have it back until WSL decides it is idle,
# which a busy server rarely is: a reboot left ~38GB of it (2026-10-23).
#
# This advises the kernel (POSIX_FADV_DONTNEED) to drop just those files, so
# other useful cache (Postgres pages, image layers) stays. Pages still in use
# (mapped by a running process) are left alone by the kernel, so it is safe to
# run at any time. Run at the end of the boot script and on a timer.
set -u

# One python pass over every file under the given roots.
PY='import os, sys
total = 0
for root in sys.argv[1:]:
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            try:
                fd = os.open(p, os.O_RDONLY)
                try:
                    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                    total += os.fstat(fd).st_size
                finally:
                    os.close(fd)
            except OSError:
                pass
print(f"{total / 1e9:.1f}GB advised under {sys.argv[1:]}")'

# Docker-volume weight caches. They live in Docker Desktop's own distro, so
# they are reached through a throwaway container that mounts each volume
# read-only (same files, same page cache). The ingestor image has python.
VOLUMES=(
  reranker-qwen-hf-cache      # search + recall rerankers (8B + 4B)
  ask-whisper-hf-cache        # dictation whisper
  embedder-hf-cache           # embedder (Qwen3-Embedding-0.6B, 2080 Ti since 2026-10-23)
  ingestor-whisper-cache      # ingestor whisper (CPU)
  ingestor-staging-whisper-cache
  ingestor-lab-whisper-cache
)
IMAGE="${EVICT_IMAGE:-ingestor-ingestor}"

before=$(awk '/^Cached:/{printf "%.1f", $2 / 1048576}' /proc/meminfo)
for v in "${VOLUMES[@]}"; do
  docker volume inspect "$v" >/dev/null 2>&1 || continue
  docker run --rm --entrypoint python -v "$v:/v:ro" "$IMAGE" -c "$PY" /v
done
# Ollama's model blobs are on this distro's own filesystem, readable only by
# the ollama user (hence sudo for the test too).
sudo -n test -d /usr/share/ollama/.ollama/models &&
  sudo -n python3 -c "$PY" /usr/share/ollama/.ollama/models
after=$(awk '/^Cached:/{printf "%.1f", $2 / 1048576}' /proc/meminfo)
echo "page cache ${before}GB -> ${after}GB"
