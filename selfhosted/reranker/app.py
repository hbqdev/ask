import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL = os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
TOKEN = os.environ.get("RERANKER_API_TOKEN", "")

_state = {"reranker": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    from FlagEmbedding import FlagReranker

    # use_fp16=False (fp32) is deliberate: this runs on a Quadro P4000
    # (Pascal GP104), whose fp16 throughput is ~1/64 of fp32, so half
    # precision is the SLOW path here. Benchmarked on 384 real passages:
    # fp32 8.25s vs fp16 13.7s (~1.7x faster) — and fp32 is more accurate.
    # fp32 uses ~4.3GB VRAM, comfortably within the 8GB card.
    _state["reranker"] = FlagReranker(MODEL, use_fp16=False)
    # Warm up CUDA kernels at startup so the first real request isn't a
    # ~25s cold start (warm inference is ~2-3s).
    _state["reranker"].compute_score([["warm", "up"]], normalize=True)
    yield
    _state["reranker"] = None


app = FastAPI(lifespan=lifespan)


class RerankRequest(BaseModel):
    query: str
    passages: list[str]
    # Per-request truncation length. Web search sends short-lived, high-volume
    # batches and omits this (default 128 = fast). Upload-RAG sends a small
    # batch of larger document chunks and requests a higher value so the
    # reranker judges the whole chunk, not just its first ~90 words. Clamped
    # server-side to bound per-pair cost.
    max_length: int = 128


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "ready": _state["reranker"] is not None}


@app.post("/rerank")
def rerank(req: RerankRequest, authorization: str = Header(default="")):
    import hmac

    if not TOKEN:
        # Fail closed: a LAN-published reranker must never serve unauthenticated.
        raise HTTPException(status_code=503, detail="server auth not configured")
    # hmac.compare_digest raises TypeError on non-ASCII input; a malformed
    # Authorization header must return a clean 401, not a 500.
    try:
        authorized = hmac.compare_digest(authorization, f"Bearer {TOKEN}")
    except TypeError:
        authorized = False
    if not authorized:
        raise HTTPException(status_code=401, detail="unauthorized")
    reranker = _state["reranker"]
    if reranker is None:
        raise HTTPException(status_code=503, detail="model not ready")
    if not req.passages:
        return {"scores": []}
    pairs = [[req.query, p] for p in req.passages]
    # normalize=True -> sigmoid -> scores in [0,1]. max_length caps per-pair
    # cost: cross-encoder attention is superlinear in sequence length, and
    # real passages are long, so on this P4000 an uncapped batch of ~150
    # passages took ~25-29s vs ~7s at 128 tokens. Clamped to [16, 512] so a
    # client can't drive an unbounded batch (512 is the model's practical
    # ceiling for this use and keeps small upload batches fast).
    max_length = max(16, min(req.max_length, 512))
    scores = reranker.compute_score(pairs, normalize=True, max_length=max_length)
    if not isinstance(scores, list):
        scores = [scores]
    return {"scores": [float(s) for s in scores]}
