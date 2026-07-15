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


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "ready": _state["reranker"] is not None}


@app.post("/rerank")
def rerank(req: RerankRequest, authorization: str = Header(default="")):
    import hmac

    if not TOKEN:
        # Fail closed: a LAN-published reranker must never serve unauthenticated.
        raise HTTPException(status_code=503, detail="server auth not configured")
    if not hmac.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401, detail="unauthorized")
    reranker = _state["reranker"]
    if reranker is None:
        raise HTTPException(status_code=503, detail="model not ready")
    if not req.passages:
        return {"scores": []}
    pairs = [[req.query, p] for p in req.passages]
    # normalize=True -> sigmoid -> scores in [0,1].
    scores = reranker.compute_score(pairs, normalize=True)
    if not isinstance(scores, list):
        scores = [scores]
    return {"scores": [float(s) for s in scores]}
