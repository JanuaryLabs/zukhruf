# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the hybrid search fixture of hybrid.golden.test.ts and hybrid.test.ts
# with Python MTEB: uv run packages/mteb/src/models/fixtures/hybrid/generate.py
#
# It writes expected.json: the fused scores of fuse_rrf, fuse_dbsf and
# fuse_relative_score_fusion for score maps made here, and the search results
# and the main score of mteb.evaluate of five HybridSearch models on the
# folder task of the BM25 fixture (../../model-implementations/fixtures/bm25),
# without the instruction of its query q10. It also writes the experiment
# names that _serialize_experiment_kwargs_to_name gives the experiment
# arguments of a hybrid with settings that are not the defaults (MTEB gives a
# hybrid none; this package does).
# Never edit expected.json by hand: run this script again.
#
# The one-hot encoder gives each text the vector with a 1 at
# (the sum of the code points of the text) % 8 and 0 elsewhere. Thus each
# cosine is exactly 0 or 1, and no order of a BLAS sum can change a bit.
# hybrid.golden.test.ts gives the same vectors through an AI SDK model.
import importlib.metadata
import importlib.util
import json
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

HERE = Path(__file__).resolve().parent
BM25_FOLDER = HERE.parent.parent / "model-implementations" / "fixtures" / "bm25"
ONE_HOT_DIM = 8

rng = random.Random(3376)


def random_scores(ids: list[str], low: float, high: float) -> dict[str, float]:
    return {doc: rng.uniform(low, high) for doc in ids}


# Score maps for one query, one map for each sub-model, in the order of the
# results of the sub-model. The ids test Python's string order: "d10" < "d9",
# "Z" < "a" < "é" and a letter outside the Basic Multilingual Plane.
CASES = [
    ("ties", [{"d9": 1.0, "d10": 1.0, "Z": 0.5, "a": 1.0}, {"a": 2.0, "é": 2.0, "d9": -1.0, "𐐀": 2.0}], [0.5, 0.5]),
    ("all equal", [{"a": 0.3, "b": 0.3, "c": 0.3}, {"b": 0.7}], [0.5, 0.5]),
    ("an empty map", [{}, {"a": 0.2, "b": 0.9}], [0.5, 0.5]),
    ("one document", [{"a": 3.25}, {"a": 1.5, "b": 0.25}], [0.5, 0.5]),
    ("negative scores", [{"a": -0.5, "b": -2.25, "c": -1.0, "d": -0.125}, {"c": -0.3, "a": 0.1}], [0.5, 0.5]),
    ("outliers clipped", [{"o": 100.0, **{f"n{i}": 1.0 + i / 7 for i in range(12)}, "u": -100.0}, {"n3": 0.5}], [0.5, 0.5]),
    # A large mean: (mean + 3 std) - (mean - 3 std) is not 6 std in float64.
    ("a large mean", [{"a": 1000000.1, "b": 1000000.3, "c": 1000000.7, "d": 999999.9}, {"b": 0.5, "e": 1.5}], [0.5, 0.5]),
    (
        "uneven weights",
        [
            random_scores([f"d{i}" for i in range(30)], 0.0, 25.0),
            random_scores([f"d{i}" for i in range(15, 45)], -1.0, 1.0),
        ],
        [0.7, 0.3],
    ),
    (
        "three models",
        [
            random_scores([f"q{i}" for i in range(9)], 0.0, 1.0),
            random_scores([f"q{i}" for i in range(4, 21)], 5.0, 50.0),
            random_scores([f"q{i}" for i in range(18, 23)], -3.0, 3.0),
        ],
        [0.2, 0.5, 0.3],
    ),
]

# The candidates of each query, as in the BM25 fixture.
TOP_RANKED = {
    "q01": ["d01", "d21", "d03"],
    "q03": ["d24", "d25", "d02"],
    "q04": ["d01", "d02"],
}

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.hybrid_wrappers import (
        HybridSearch,
        fuse_dbsf,
        fuse_relative_score_fusion,
        fuse_rrf,
    )
    from mteb.models.model_implementations.bm25 import bm25_s
    from mteb.models.model_meta import ModelMeta, _serialize_experiment_kwargs_to_name

    def as_pairs(scores) -> list:
        return [[doc, score] for doc, score in scores.items()]

    large = np.array(list({case: maps for case, maps, _ in CASES}["a large mean"][0].values()))
    mu, sigma = np.mean(large), np.std(large)
    assert (mu + 3 * sigma) - (mu - 3 * sigma) != 6 * sigma, "the large mean case lost its purpose"

    fusions = []
    for case, query_scores_list, weights in CASES:
        fusions.append(
            {
                "case": case,
                "query_scores_list": [as_pairs(scores) for scores in query_scores_list],
                "weights": weights,
                "rrf_60": as_pairs(fuse_rrf(query_scores_list, weights)),
                "rrf_0": as_pairs(fuse_rrf(query_scores_list, weights, rrf_k=0)),
                "dbsf": as_pairs(fuse_dbsf(query_scores_list, weights)),
                "rsf": as_pairs(fuse_relative_score_fusion(query_scores_list, weights)),
            }
        )

    class OneHot(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/one-hot", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            rows = []
            for batch in inputs:
                for text in batch["text"]:
                    vector = np.zeros(ONE_HOT_DIM, dtype=np.float32)
                    vector[sum(map(ord, text)) % ONE_HOT_DIM] = 1.0
                    rows.append(vector)
            return np.stack(rows)

    # A custom fusion: the greatest weighted score of each document.
    def maximum(query_scores_list, weights):
        fused = {}
        for scores, weight in zip(query_scores_list, weights, strict=True):
            for doc, score in scores.items():
                fused[doc] = max(fused.get(doc, float("-inf")), weight * score)
        return fused

    MODELS = {
        "rrf": lambda: HybridSearch([bm25_s.load_model(), bm25_s.load_model(k1=1.2, b=0.5)]),
        "dbsf": lambda: HybridSearch(
            [bm25_s.load_model(), bm25_s.load_model(k1=1.2, b=0.5)], fusion_strategy="dbsf"
        ),
        "rsf": lambda: HybridSearch(
            [bm25_s.load_model(), bm25_s.load_model(k1=1.2, b=0.5)], fusion_strategy="rsf"
        ),
        "custom": lambda: HybridSearch(
            [bm25_s.load_model(), bm25_s.load_model(k1=1.2, b=0.5)], fusion_strategy=maximum
        ),
        "encoder": lambda: HybridSearch([bm25_s.load_model(), OneHot()], weights=[0.6, 0.4]),
    }

    class HybridFixture(AbsTaskRetrieval):
        metadata = TaskMetadata(
            name="HybridFixture",
            description="The hybrid search fixture of @zukhruf/mteb.",
            dataset={"path": str(BM25_FOLDER), "revision": "1"},
            type="Retrieval",
            category="t2t",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="ndcg_at_10",
        )

        # One query of the BM25 fixture has an instruction and the others
        # have None, which the dataloader of an encoder rejects ("Found None
        # in batch"). The queries here have no instructions.
        def dataset_transform(self, num_proc=None, **kwargs):
            split = self.dataset["default"]["test"]
            split["queries"] = split["queries"].remove_columns("instruction")

    task = HybridFixture()
    task.load_data()
    split = task.dataset["default"]["test"]
    location = {
        "task_metadata": task.metadata,
        "hf_split": "test",
        "hf_subset": "default",
        "encode_kwargs": {},
    }

    def run(model_name, top_k, top_ranked):
        model = MODELS[model_name]()
        model.index(split["corpus"], **location)
        results = model.search(split["queries"], top_k=top_k, top_ranked=top_ranked, **location)
        return [[query, as_pairs(docs)] for query, docs in results.items()]

    searches = []
    for model_name in MODELS:
        searches.append({"model": model_name, "top_k": 100, "rerank": False, "results": run(model_name, 100, None)})
    searches.append({"model": "rrf", "top_k": 5, "rerank": False, "results": run("rrf", 5, None)})
    searches.append({"model": "encoder", "top_k": 100, "rerank": True, "results": run("encoder", 100, TOP_RANKED)})

    evaluations = []
    for model_name, make in MODELS.items():
        model = make()
        result = mteb.evaluate(model, task, cache=None)
        evaluations.append(
            {
                "model": model_name,
                "name": model.mteb_model_meta.name,
                "main_score": result.task_results[0].scores["test"][0]["main_score"],
            }
        )

    k1 = bm25_s.load_model(k1=1.2).mteb_model_meta.experiment_name
    k1_b = bm25_s.load_model(k1=1.2, b=0.5).mteb_model_meta.experiment_name
    # The experiment arguments of each case, as hybrid.test.ts makes them.
    EXPERIMENTS = {
        "a sub-model setting": {"sub_models": [None, k1]},
        "weights": {"weights": [0.6, 0.4]},
        "rrf_k": {"rrf_k": 10},
        "sub_model_top_k": {"sub_model_top_k": 5},
        "all": {"sub_models": [k1_b, None], "weights": [0.7, 0.3], "rrf_k": 0, "sub_model_top_k": 50},
    }
    experiment_names = [
        {"case": case, "experiment_name": _serialize_experiment_kwargs_to_name(kwargs)}
        for case, kwargs in EXPERIMENTS.items()
    ]

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, bm25s {VERSIONS['bm25s']}, "
    f"PyStemmer {VERSIONS['PyStemmer']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "one_hot_dim": ONE_HOT_DIM,
            "top_ranked": TOP_RANKED,
            "fusions": fusions,
            "searches": searches,
            "evaluations": evaluations,
            "experiment_names": experiment_names,
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(
    f"{generator}: {len(fusions) * 4} fused maps, {len(searches)} searches, {len(evaluations)} main scores",
    file=sys.stderr,
)
