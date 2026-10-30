# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of predictions.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/predictions/generate.py
#
# The ids of the queries and the documents are integer-like ("10", "2"). A
# JavaScript object puts such keys first, in ascending order, but Python
# keeps the order of a dict. The test makes sure that the port keeps the
# order of a predictions file as MTEB does.
#
# It writes next to this file:
# - the folder dataset (README.md, corpus.jsonl, queries.jsonl,
#   qrels/test.jsonl, qrels/dev.jsonl);
# - saved/KeyOrder_predictions.json: the PREDICTIONS below, written by MTEB's
#   _save_task_predictions, one call for each split. The scores tie at the
#   top_k cut and at the first result;
# - evaluated/KeyOrder_predictions.json: the predictions file that
#   mteb.evaluate writes for mteb/baseline-bm25s with a prediction_folder.
#   Each document of a query has another score, so the order of the search
#   is fixed;
# - non-finite/KeyOrder_predictions.json: the NON_FINITE predictions, written
#   by _save_task_predictions, so the file holds the NaN, Infinity and
#   -Infinity tokens of Python's json module;
# - expected.json: the top_ranked of convert_to_reranking(saved, top_k=2),
#   the ndcg_cut_10 of each query that calculate_retrieval_scores gives for
#   the saved test split with skip_first_result, and for non-finite/ the
#   predictions that json.load reads and the top_ranked of
#   convert_to_reranking. Each dict is a list of pairs, so that the order
#   survives JSON.parse; a float that JSON cannot hold is a string.
# Never edit expected.json or a predictions file by hand: run this script
# again.
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

# bm25s picks jax for the top-k and numba for the scores when they are
# installed. MTEB's numbers here come from its numpy path.
for module in ("jax", "numba"):
    assert importlib.util.find_spec(module) is None, f"{module} must not be installed"

VERSIONS = {
    "mteb": "2.26.28",
    "bm25s": "0.3.16",
    "PyStemmer": "3.1.0",
    "numpy": "2.5.4",
    "datasets": "5.1.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent
TOP_K = 2

# Each document holds "omega" a different number of times, and each query
# asks for it, so each document scores above 0 for each query.
CORPUS = [
    ("7", "alpha alpha alpha beta omega"),
    ("3", "alpha alpha beta beta gamma omega omega"),
    ("12", "alpha gamma gamma delta omega omega omega"),
    ("0", "alpha delta omega omega omega omega"),
    ("5", "beta beta beta delta delta omega omega omega omega omega"),
    ("21", "gamma delta delta delta omega omega omega omega omega omega"),
    ("1", "alpha beta gamma delta omega omega omega omega omega omega omega"),
    ("10", "beta gamma omega omega omega omega omega omega omega omega"),
]

# (split, id, text, relevant documents)
QUERIES = [
    ("test", "10", "alpha beta omega", ["7"]),
    ("test", "2", "gamma delta omega", ["5"]),
    ("dev", "1", "alpha delta omega", ["21"]),
    ("dev", "33", "beta gamma delta omega", ["10"]),
]

# The predictions of _save_task_predictions, by split. In each query, the
# documents are in another order than the numbers of their ids. Query 10
# ties three documents at the top_k cut; query 2 ties its first two.
PREDICTIONS = {
    "test": {
        "10": {"12": 0.9, "7": 0.5, "3": 0.5, "21": 0.5, "1": 0.2},
        "2": {"5": 0.8, "0": 0.8, "21": 0.1, "10": 0.05},
    },
    "dev": {
        "33": {"21": 0.7, "10": 0.7, "1": 0.7, "0": 0.3},
        "1": {"3": 0.6, "0": 0.4, "21": 0.4},
    },
}

# Predictions with a NaN score, an inf score and a -inf score.
NON_FINITE = {
    "test": {
        "10": {"4": 0.3, "8": math.nan, "2": math.inf, "6": 0.9, "1": 0.1},
        "2": {"5": 0.8, "0": -math.inf, "21": 0.1},
    },
    "dev": {
        "33": {"21": 0.7, "10": 0.2},
        "1": {"3": 0.6, "0": 0.4},
    },
}


def number(value: float) -> float | str:
    return value if math.isfinite(value) else repr(value).replace("inf", "Infinity").replace("nan", "NaN")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


(HERE / "README.md").write_text(
    """---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
      - split: dev
        path: qrels/dev.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
---
""",
    encoding="utf-8",
)
write_jsonl(HERE / "corpus.jsonl", [{"_id": doc, "title": "", "text": text} for doc, text in CORPUS])
write_jsonl(HERE / "queries.jsonl", [{"_id": query, "text": text} for _, query, text, _ in QUERIES])
for split in ("test", "dev"):
    write_jsonl(
        HERE / "qrels" / f"{split}.jsonl",
        [
            {"query-id": query, "corpus-id": doc, "score": 1}
            for query_split, query, _, docs in QUERIES
            if query_split == split
            for doc in docs
        ],
    )

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    from mteb._evaluators.retrieval_metrics import calculate_retrieval_scores
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.model_implementations.bm25 import bm25_s

    class KeyOrder(AbsTaskRetrieval):
        metadata = TaskMetadata(
            name="KeyOrder",
            description="The predictions fixture of @zukhruf/mteb.",
            dataset={"path": str(HERE), "revision": "1"},
            type="Retrieval",
            category="t2t",
            modalities=["text"],
            eval_splits=["test", "dev"],
            eval_langs=["eng-Latn"],
            main_score="ndcg_at_10",
        )

    saved = HERE / "saved"
    shutil.rmtree(saved, ignore_errors=True)
    model = SimpleNamespace(mteb_model_meta=SimpleNamespace(name="key-order/model", revision="1"))
    for split, predictions in PREDICTIONS.items():
        KeyOrder()._save_task_predictions(predictions, model, saved, split, "default")

    task = KeyOrder().convert_to_reranking(saved, top_k=TOP_K)
    top_ranked = {
        split: [[query, list(docs)] for query, docs in task.dataset["default"][split]["top_ranked"].items()]
        for split in PREDICTIONS
    }

    non_finite = HERE / "non-finite"
    shutil.rmtree(non_finite, ignore_errors=True)
    for split, predictions in NON_FINITE.items():
        KeyOrder()._save_task_predictions(predictions, model, non_finite, split, "default")
    with (non_finite / "KeyOrder_predictions.json").open("r", encoding="utf-8") as file:
        non_finite_loaded = json.load(file)
    non_finite_scores = [
        [subset, [[split, [[query, [[doc, number(score)] for doc, score in scores.items()]] for query, scores in queries.items()]] for split, queries in splits.items()]]
        for subset, splits in non_finite_loaded.items()
        if subset != "mteb_model_meta"
    ]
    non_finite_task = KeyOrder().convert_to_reranking(non_finite, top_k=TOP_K)
    non_finite_top_ranked = {
        split: [[query, list(docs)] for query, docs in non_finite_task.dataset["default"][split]["top_ranked"].items()]
        for split in NON_FINITE
    }

    run = json.loads((saved / "KeyOrder_predictions.json").read_text("utf-8"))["default"]["test"]
    scoring = KeyOrder()
    scoring.load_data()
    relevant = {
        query: docs for query, docs in scoring.dataset["default"]["test"]["relevant_docs"].items() if len(docs) > 0
    }
    evaluation = calculate_retrieval_scores(run, relevant, scoring.k_values, skip_first_result=True)
    per_query = [[query, values["ndcg_cut_10"]] for query, values in evaluation.all_scores.items()]

    evaluated = HERE / "evaluated"
    shutil.rmtree(evaluated, ignore_errors=True)
    mteb.evaluate(bm25_s.load_model(), KeyOrder(), cache=None, prediction_folder=evaluated)
    written = json.loads((evaluated / "KeyOrder_predictions.json").read_text("utf-8"))
    for split in ("test", "dev"):
        for query, scores in written["default"][split].items():
            assert len(set(scores.values())) == len(scores), (split, query, scores)
            assert list(scores) != sorted(scores, key=int), (split, query, list(scores))

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, bm25s {VERSIONS['bm25s']}, "
    f"PyStemmer {VERSIONS['PyStemmer']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "top_k": TOP_K,
            "top_ranked": top_ranked,
            "per_query": per_query,
            "non_finite": {"predictions": non_finite_scores, "top_ranked": non_finite_top_ranked},
        },
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: top_ranked {top_ranked}, per_query {per_query}", file=sys.stderr)
