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

    # use_fp16 halves VRAM and speeds inference; harmless on CPU fallback.
    _state["reranker"] = FlagReranker(MODEL, use_fp16=True)
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
