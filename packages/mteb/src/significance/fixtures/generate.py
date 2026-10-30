# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of paired-bootstrap.golden.test.ts with Python MTEB and
# NumPy: uv run packages/mteb/src/significance/fixtures/generate.py
#
# MTEB has no significance test, so the bootstrap here is plain NumPy:
# default_rng(seed).integers(0, n, n) for each replicate, np.mean of the
# differences it draws, and np.percentile(..., [2.5, 97.5]) of the replicate
# means. The differences are change - baseline, in the order of the sorted
# query ids.
#
# It writes expected.json:
# - for mteb/baseline-bm25s with the default settings (the baseline) and with
#   k1=1.2, b=0.5 (the change) on the folder task of the BM25 fixture
#   (../../models/model-implementations/fixtures/bm25): the main score of
#   mteb.evaluate, and the ndcg_cut_10 of each query that
#   calculate_retrieval_scores gives for the predictions file of evaluate;
# - the bootstrap of that pair;
# - the bootstrap of synthetic pairs: all differences 0, all above 0, all
#   below 0, one query, and query ids whose Python order is not the order of
#   UTF-16 code units, with another seed and number of replicates;
# - np.percentile of a few arrays at 11 percentiles.
# Never edit expected.json by hand: run this script again. A float that JSON
# cannot hold is a string.
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import random
import sys
import tempfile
from pathlib import Path

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

import numpy as np  # noqa: E402

HERE = Path(__file__).resolve().parent
BM25_FOLDER = HERE.parent.parent / "models" / "model-implementations" / "fixtures" / "bm25"
SEED = 31957
REPLICATES = 2000

rng = random.Random(3410)


def number(value: float) -> float | str:
    return value if math.isfinite(value) else repr(value).replace("inf", "Infinity").replace("nan", "NaN")


def bootstrap(baseline: dict[str, float], change: dict[str, float], seed: int, replicates: int) -> dict:
    queries = sorted(baseline)
    assert queries == sorted(change)
    differences = np.array([change[query] - baseline[query] for query in queries], dtype=np.float64)
    n = len(differences)
    generator = np.random.default_rng(seed)
    means = np.array([np.mean(differences[generator.integers(0, n, n)]) for _ in range(replicates)])
    low, high = np.percentile(means, [2.5, 97.5])
    observed = float(np.mean(differences))
    result = "better" if low > 0 else "worse" if high < 0 else "inconclusive"
    return {
        "observed": number(observed),
        "low": number(float(low)),
        "high": number(float(high)),
        "result": result,
        "queries": n,
        "replicates": replicates,
        "seed": seed,
    }


def scores(ids: list[str], low: float, high: float) -> dict[str, float]:
    return {query: rng.uniform(low, high) for query in ids}


def shuffled(values: dict[str, float]) -> dict[str, float]:
    items = list(values.items())
    rng.shuffle(items)
    return dict(items)


# (case, baseline, change, seed, replicates). The change keeps its queries in
# another order than the baseline.
ids = [f"q{i}" for i in range(1, 31)]
base = scores(ids, 0.0, 1.0)
odd_ids = ["q9", "q10", "Z", "a", "é", "ﬁ", "\U00010400", "q2"]
odd_base = scores(odd_ids, 0.0, 1.0)
SYNTHETIC = [
    ("all equal", base, shuffled(base), SEED, REPLICATES),
    ("all better", base, shuffled({query: score + rng.uniform(0.01, 0.2) for query, score in base.items()}), SEED, REPLICATES),
    ("all worse", base, shuffled({query: score - rng.uniform(0.01, 0.2) for query, score in base.items()}), SEED, REPLICATES),
    ("one query", {"q1": 0.25}, {"q1": 0.75}, SEED, REPLICATES),
    ("mixed", odd_base, shuffled(scores(odd_ids, 0.0, 1.0)), 7, 500),
]

PERCENTILES = [
    [0.5],
    [0.1, 0.2, 0.33, 0.5, 0.9],
    sorted(rng.uniform(-1.0, 1.0) for _ in range(20)),
    sorted(rng.uniform(-1.0, 1.0) for _ in range(2000)),
    *(sorted(rng.uniform(-1.0, 1.0) for _ in range(n)) for n in (3, 7, 50, 333)),
]
QUANTILES = [0.0, 2.5, 10.0, 25.0, 33.3, 50.0, 66.7, 75.0, 90.0, 97.5, 100.0]

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

    class SignificanceFixture(AbsTaskRetrieval):
        metadata = TaskMetadata(
            name="SignificanceFixture",
            description="The significance fixture of @zukhruf/mteb.",
            dataset={"path": str(BM25_FOLDER), "revision": "1"},
            type="Retrieval",
            category="t2t",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="ndcg_at_10",
        )

    def per_query(model) -> tuple[float, dict[str, float]]:
        task = SignificanceFixture()
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text("utf-8"))
        main_score = result.task_results[0].scores["test"][0]["main_score"]
        task.load_data()
        relevant = {
            query: docs for query, docs in task.dataset["default"]["test"]["relevant_docs"].items() if len(docs) > 0
        }
        run = predictions["default"]["test"]
        assert not task.ignore_identical_ids
        evaluation = calculate_retrieval_scores(run, relevant, task.k_values, task.skip_first_result)
        values = {query: evaluation.all_scores[query]["ndcg_cut_10"] for query in sorted(evaluation.all_scores)}
        return main_score, values

    baseline_main, baseline = per_query(bm25_s.load_model())
    change_main, change = per_query(bm25_s.load_model(k1=1.2, b=0.5))

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, bm25s {VERSIONS['bm25s']}, "
    f"PyStemmer {VERSIONS['PyStemmer']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "bm25": {
                "baseline": {"main_score": baseline_main, "per_query": baseline},
                "change": {"main_score": change_main, "per_query": change},
                "verdict": bootstrap(baseline, change, SEED, REPLICATES),
            },
            "synthetic": [
                {
                    "case": case,
                    "baseline": list(left.items()),
                    "change": list(right.items()),
                    "verdict": bootstrap(left, right, seed, replicates),
                }
                for case, left, right, seed, replicates in SYNTHETIC
            ],
            "percentiles": [
                {"sorted": values, "q": QUANTILES, "values": [float(v) for v in np.percentile(values, QUANTILES)]}
                for values in PERCENTILES
            ],
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(baseline)} queries, {len(SYNTHETIC)} synthetic cases", file=sys.stderr)
