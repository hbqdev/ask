import os
import urllib.request
import json

BASE = os.environ.get("BASE", "http://127.0.0.1:8787")
TOKEN = os.environ.get("RERANKER_API_TOKEN", "")


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


resp = post("/rerank", {
    "query": "How does photosynthesis work?",
    "passages": [
        "Photosynthesis converts sunlight, water and CO2 into glucose and oxygen in plant chloroplasts.",
        "The stock market fell three percent on Tuesday amid inflation fears.",
    ],
})
scores = resp["scores"]
print("scores:", scores)
assert len(scores) == 2, "expected 2 scores"
assert scores[0] > scores[1], "on-topic passage must outrank off-topic"
print("SMOKE TEST PASSED")
