"""Round 15 (#3421): collect Liquid AI d1-2B answers for every article of a slice.

Copied from round-13/collect.py; only the slice guard, the usage and the rule path differ.
selection-rule.json (sha256 of round-15/selection-rule.json) 'answers': one /v1/systemone call per article;
state = title + '\\n' + lead; one 'noul' question per profile with instructions
'Is the main subject of this article: <profile description>?' (profiles.json description,
word for word, so a description that ends with '.' gives '...supplied.?'). A failed call is
retried at most 3 times (at most 4 attempts); an article that still fails is recorded.

Usage (from round-15/):
  python3 -I collect.py fresh-6 d1-answers.json            # the real collection
  python3 -I collect.py fresh-4 OUT.json --limit 20        # a test of this script
It reads only <slice>/articles.json (checked against <slice>/articles.sha256) and never a
label file; for fresh-6 it refuses to start, and refuses to write, when fresh-6/labels.json
or any fresh-6/labels-*.jsonl exists. Writes OUT.json; freeze it afterwards with ../freeze.py.
"""
import hashlib
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BASE = "http://mac-mini.tailf1764a.ts.net:9931"
MODEL = "d1-2b"
RETRIES = 3
TIMEOUT = 120

slice_name, out_path = sys.argv[1], Path(sys.argv[2])
limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
folder = ROOT / slice_name
labels_file = folder / "labels.json"


def no_labels():
    if slice_name == "fresh-6" and (labels_file.exists() or any(folder.glob("labels-*.jsonl"))):
        sys.exit("fresh-6 labels exist: the answers must be frozen before the labels. Stopping.")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=TIMEOUT) as r:
        return json.load(r)


def post(body):
    req = urllib.request.Request(BASE + "/v1/systemone", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


no_labels()
articles_sha = sha(folder / "articles.json")
assert articles_sha == (folder / "articles.sha256").read_text().strip(), "articles.json does not match its frozen sha256"
articles = json.loads((folder / "articles.json").read_text())
profiles = json.loads((ROOT / "profiles.json").read_text())["profiles"]
questions = {p["id"]: {"type": "noul", "instructions": f"Is the main subject of this article: {p['description']}?"}
             for p in profiles}
models = get("/v1/models")
model_entry = next(m for m in models["data"] if MODEL in m.get("aliases", []) or m["id"] == MODEL)
props = get("/props")

# Resumable (2026-10-31): each answered article goes to OUT.partial.jsonl at
# once, and a restart skips the articles it holds, so a sleep or a network
# drop loses one call, not the run. The answers are the same either way.
partial_path = out_path.with_suffix(".partial.jsonl")
done = {}
if partial_path.exists():
    lines = partial_path.read_text().splitlines()
    header = json.loads(lines[0])
    assert header["articlesSha256"] == articles_sha, "the partial file is for other articles"
    started = header["startedAt"]
    done = {row["id"]: row for row in map(json.loads, lines[1:]) if row}
    print(f"resuming: {len(done)} articles already answered", file=sys.stderr, flush=True)
else:
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    partial_path.write_text(json.dumps({"startedAt": started, "articlesSha256": articles_sha}) + "\n")
partial = partial_path.open("a")
selected = articles[:limit] if limit else articles
for k, a in enumerate(selected):
    if a["id"] in done:
        continue
    body = {"model": MODEL, "state": f"{a['title']}\n{a['lead']}", "questions": questions}
    errors, answers, t0 = [], None, time.time()
    for attempt in range(1 + RETRIES):
        try:
            res = post(body)
            got = {q: float(res["answers"][q]["noul"]) for q in questions}
            assert all(0 <= v <= 1 for v in got.values()), "noul outside [0, 1]"
            answers = got
            break
        except Exception as e:  # recorded, then retried
            errors.append(f"{type(e).__name__}: {e}")
            time.sleep(2)
    row = {"id": a["id"], "attempts": len(errors) + (answers is not None), "seconds": round(time.time() - t0, 3),
           "answers": answers, "errors": errors}
    done[a["id"]] = row
    partial.write(json.dumps(row) + "\n")
    partial.flush()
    if k % 100 == 0:
        print(f"{k} articles, {sum(r['answers'] is None for r in done.values())} failed", file=sys.stderr, flush=True)
partial.close()
rows = [done[a["id"]] for a in selected]
failures = [row["id"] for row in rows if row["answers"] is None]

no_labels()
json.dump({
    "rule": {"file": "round-15/selection-rule.json", "sha256": sha(HERE / "selection-rule.json")},
    "slice": slice_name, "articlesSha256": articles_sha, "profilesSha256": sha(ROOT / "profiles.json"),
    "endpoint": BASE + "/v1/systemone", "model": model_entry, "server": {"build_info": props.get("build_info")},
    "questions": questions, "retries": RETRIES, "startedAt": started,
    "finishedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "articles": len(rows), "failed": failures, "rows": rows,
}, open(out_path, "w"), indent=1)
partial_path.unlink()
print(json.dumps({"articles": len(rows), "failed": len(failures)}))
