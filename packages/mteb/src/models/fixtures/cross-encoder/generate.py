# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "requests==2.34.2"]
# ///
# Makes the cross-encoder fixture of cross-encoder.golden.test.ts with Python
# MTEB: uv run packages/mteb/src/models/fixtures/cross-encoder/generate.py
#
# It writes the reranking dataset in dataset/ and expected.json: the
# requests that OpenAIAPIRerankWrapper sends to a fake reranking server, the
# results of SearchCrossEncoderWrapper.search, and the predictions file, the
# main score and the phase names of mteb.evaluate, for NoRerankingBaseline,
# the wrapper and a HybridSearch of the two.
# Never edit expected.json by hand: run this script again.
#
# The fake server scores a pair as
# ((cp(query) * 131 + cp(document) * 17) % 997) / 997 + len(document) / 3,
# where cp is the sum of the code points and len counts code points. Only
# integer arithmetic, one division and one sum of doubles are used, so the
# score is the same double in Python and in JavaScript.
import importlib.metadata
import json
import os
import platform
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSIONS = {
    "mteb": "2.26.28",
    "numpy": "2.5.4",
    "torch": "2.14.1",
    "datasets": "5.1.0",
    "requests": "2.34.2",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent
DATASET = HERE / "dataset"
BATCH_SIZE = 3
TOP_K = 1

# d2 and d4 have the same text, so the server gives them the same score.
CORPUS = [
    ("d1", "Cats", "Cats sleep all day."),
    ("d2", "", "Dogs bark at night."),
    ("d3", "Birds", "Birds sing at dawn."),
    ("d4", "", "Dogs bark at night."),
    ("d5", "Fish", "Fish swim in water."),
    ("d6", "Ünïcode", "𐐀 is outside the plane."),
    ("d7", "", "A long document about cats, dogs and birds."),
]
# Each query has an instruction: the dataloader of a model stops at a batch
# where only some queries have one ("Found None in batch").
QUERIES = [
    ("q1", "Which animals sleep?", "Find animals"),
    ("q2", "Who barks?", "Find dogs"),
    ("q3", "Nothing ranked", "Find fish"),
    ("q4", "Empty candidates", "Find birds"),
    ("q5", "𐐀 query", "Find letters"),
    ("q6", "Who swims?", "Find fish"),
]
QRELS = [("q1", "d1"), ("q2", "d2"), ("q3", "d5"), ("q4", "d3"), ("q5", "d6"), ("q6", "d5")]
# q1 repeats d1 and is not in the order of the scores, q2 has two candidates
# with equal scores, q3 has no row and q4 has an empty list. The 10 pairs are
# not a multiple of BATCH_SIZE.
TOP_RANKED = [
    ("q1", ["d3", "d1", "d7", "d1"]),
    ("q2", ["d2", "d4", "d5"]),
    ("q4", []),
    ("q5", ["d6", "d1"]),
    ("q6", ["d5"]),
]


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


shutil.rmtree(DATASET, ignore_errors=True)
(DATASET).mkdir(parents=True)
(DATASET / "README.md").write_text(
    """---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
  - config_name: instruction
    data_files:
      - split: test
        path: instruction.jsonl
  - config_name: top_ranked
    data_files:
      - split: test
        path: top_ranked.jsonl
---
""",
    encoding="utf-8",
)
write_jsonl(DATASET / "corpus.jsonl", [{"_id": doc, "title": title, "text": text} for doc, title, text in CORPUS])
write_jsonl(DATASET / "queries.jsonl", [{"_id": query, "text": text} for query, text, _ in QUERIES])
write_jsonl(
    DATASET / "instruction.jsonl",
    [{"query-id": query, "instruction": instruction} for query, _, instruction in QUERIES],
)
write_jsonl(DATASET / "qrels" / "test.jsonl", [{"query-id": q, "corpus-id": d, "score": 1} for q, d in QRELS])
write_jsonl(DATASET / "top_ranked.jsonl", [{"query-id": q, "corpus-ids": docs} for q, docs in TOP_RANKED])


def code_points(text: str) -> int:
    return sum(map(ord, text))


def fake_score(query: str, document: str) -> float:
    return ((code_points(query) * 131 + code_points(document) * 17) % 997) / 997 + len(document) / 3


requests_seen: list = []


class FakeReranker(BaseHTTPRequestHandler):
    def _send(self, body) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        assert self.path == "/v1/models", self.path
        self._send({"data": [{"id": "fake/reranker"}]})

    def do_POST(self) -> None:
        assert self.path == "/v1/rerank", self.path
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests_seen.append([payload["query"], payload["documents"]])
        scores = [fake_score(payload["query"], document) for document in payload["documents"]]
        order = sorted(range(len(scores)), key=lambda index: -scores[index])
        self._send({"results": [{"index": index, "relevance_score": scores[index]} for index in order]})

    def log_message(self, *args) -> None:
        pass


def pairs(scores) -> list:
    return [[key, value] for key, value in scores.items()]


def nested(value):
    if isinstance(value, dict):
        return [[key, nested(item)] for key, item in value.items()]
    return value


server = ThreadingHTTPServer(("127.0.0.1", 0), FakeReranker)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    # The datasets library keeps the Arrow files of a local dataset in its
    # cache. A temporary cache leaves nothing behind.
    with tempfile.TemporaryDirectory() as cache, tempfile.TemporaryDirectory() as predictions:
        os.environ["HF_DATASETS_CACHE"] = cache
        os.environ["HF_HUB_OFFLINE"] = "1"

        import mteb
        from mteb.abstasks.retrieval import AbsTaskRetrieval
        from mteb.abstasks.task_metadata import TaskMetadata
        from mteb.models.hybrid_wrappers import HybridSearch
        from mteb.models.openai_wrappers import OpenAIAPIRerankWrapper
        from mteb.models.search_wrappers import SearchCrossEncoderWrapper

        endpoint = f"http://127.0.0.1:{server.server_address[1]}"

        class CrossEncoderFixture(AbsTaskRetrieval):
            metadata = TaskMetadata(
                name="CrossEncoderFixture",
                description="The cross-encoder fixture of @zukhruf/mteb.",
                dataset={"path": str(DATASET), "revision": "1"},
                type="Reranking",
                category="t2t",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=["eng-Latn"],
                main_score="ndcg_at_10",
            )

        MODELS = {
            "baseline": lambda: mteb.get_model("mteb/baseline-no-reranking"),
            "reranker": lambda: OpenAIAPIRerankWrapper(endpoint_url=endpoint, model_name="fake/reranker"),
            "hybrid": lambda: HybridSearch(
                [
                    mteb.get_model("mteb/baseline-no-reranking"),
                    OpenAIAPIRerankWrapper(endpoint_url=endpoint, model_name="fake/reranker"),
                ]
            ),
        }

        task = CrossEncoderFixture()
        task.load_data()
        split = task.dataset["default"]["test"]
        location = {
            "task_metadata": task.metadata,
            "hf_split": "test",
            "hf_subset": "default",
            "encode_kwargs": {"batch_size": BATCH_SIZE},
        }

        searches = []
        for model_name in ("baseline", "reranker"):
            wrapper = SearchCrossEncoderWrapper(MODELS[model_name]())
            wrapper.index(split["corpus"], **location)
            requests_seen.clear()
            results = wrapper.search(split["queries"], top_k=TOP_K, top_ranked=split["top_ranked"], **location)
            searches.append(
                {
                    "model": model_name,
                    "requests": list(requests_seen),
                    "results": [[query, pairs(docs)] for query, docs in results.items()],
                }
            )

        evaluations = []
        for model_name, make in MODELS.items():
            model = make()
            folder = Path(predictions) / model_name
            requests_seen.clear()
            result = mteb.evaluate(
                model,
                CrossEncoderFixture(),
                cache=None,
                encode_kwargs={"batch_size": BATCH_SIZE},
                prediction_folder=folder,
            )
            task_result = result.task_results[0]
            written = json.loads((folder / "CrossEncoderFixture_predictions.json").read_text("utf-8"))
            evaluations.append(
                {
                    "model": model_name,
                    "name": model.mteb_model_meta.name,
                    "main_score": task_result.scores["test"][0]["main_score"],
                    "requests": list(requests_seen),
                    "predictions": nested(written),
                    "phases": [[phase["name"], phase["split"], phase["subset"]] for phase in task_result.evaluation_phases],
                }
            )
finally:
    server.shutdown()
    server.server_close()
    thread.join()

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, requests {VERSIONS['requests']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "batch_size": BATCH_SIZE,
            "top_k": TOP_K,
            "searches": searches,
            "evaluations": evaluations,
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(searches)} searches, {len(evaluations)} evaluations", file=sys.stderr)
