# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "scikit-learn==1.9.1", "scipy==1.18.1"]
# ///
# Makes the STS fixture of sts.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/sts/generate.py
#
# It writes:
# - folder/test.jsonl: a folder dataset of pairs with a gold score. Each text
#   is a vector of 136 numbers with spaces between them. The vector encoder
#   reads the text as a float32 vector. The folder task has min_score -2 and
#   max_score 3, so some gold scores are negative or zero.
# - hub/: a slice of STSBenchmark at the revision of its metadata, in the
#   cache layout of dependencies/datasets.ts: the first 60 rows of
#   test.jsonl.gz and the first 5 rows of train.jsonl.gz and
#   validation.jsonl.gz. The task has no dataset_transform.
# - expected.json: for each of the two tasks, the scores of mteb.evaluate,
#   the predictions file that it wrote and the gold scores of the test split
#   that _normalize gives (for STSBenchmark, also the gold scores); and the rankdata, pearsonr and spearmanr of SciPy
#   for arrays made here.
# Never edit these files by hand: run this script again.
#
# The STSBenchmark run uses the code point encoder: 8 values, where the
# value at k is the number of code points c of the text with c % 8 == k.
import gzip
import importlib.metadata
import json
import math
import os
import platform
import random
import shutil
import sys
import tempfile
from pathlib import Path

VERSIONS = {
    "mteb": "2.26.28",
    "numpy": "2.5.4",
    "torch": "2.14.1",
    "datasets": "5.1.0",
    "scikit-learn": "1.9.1",
    "scipy": "1.18.1",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent
FOLDER = HERE / "folder"
STSB_REPO = "mteb/stsbenchmark-sts"
STSB_REVISION = "b0fddb56ed78048fa8b90373c8a3cfc37b684831"
HUB = HERE / "hub"
STSB_FOLDER = HUB / STSB_REPO / STSB_REVISION
CODE_POINT_DIM = 8
MIN_SCORE = -2
MAX_SCORE = 3

rng = random.Random(3243)


def vector_text(values) -> str:
    return " ".join(repr(float(value)) for value in values)


# 136 values: numpy's float32 sum of a row of more than 128 values splits it
# in two, and each half adds in 8 accumulators and then the rest in order.
DIM = 136


def padded(values) -> list[float]:
    return [float(value) for value in values] + [0.0] * (DIM - len(values))


def random_vector() -> list[float]:
    return [rng.choice([-2.0, -1.5, -1.0, -0.3, 0.0, 0.1, 0.7, 1.0, 1.25, 2.0, 3.0]) for _ in range(DIM)]


# The pairs of the folder task: (vector 1, vector 2, gold score).
pairs = [
    # Equal vectors: cosine 1, distances 0 (negated: -0.0).
    ([1, 2, 3, 4], [1, 2, 3, 4], 3),
    # A zero vector: sklearn's normalize keeps it zero, torch divides by 1e-12.
    ([0, 0, 0, 0], [1, 1, 0, 0], -2),
    # Opposite vectors: negative cosine.
    ([1, -1, 2, 0], [-1, 1, -2, 0], -1.5),
    # The same pair three times with other gold scores: tied similarities.
    ([0.1, 0.2, 0.3, 0.4], [0.3, 0.1, 0.2, 0.7], 0),
    ([0.1, 0.2, 0.3, 0.4], [0.3, 0.1, 0.2, 0.7], 0.0),
    ([0.1, 0.2, 0.3, 0.4], [0.3, 0.1, 0.2, 0.7], 1.2),
    # Powers of two: every float32 operation is exact.
    ([1, 1, 1, 1], [1, -1, 1, 1], 2.5),
    ([2, 0, 0, 0], [0, 2, 0, 0], -0.4),
]
pairs = [(padded(left), padded(right), score) for left, right, score in pairs]
# Gold scores with ties, from MIN_SCORE to MAX_SCORE in steps of 0.2.
pairs += [(random_vector(), random_vector(), rng.randint(-10, 15) / 5) for _ in range(32)]

FOLDER.mkdir(exist_ok=True)
with (FOLDER / "test.jsonl").open("w", encoding="utf-8") as file:
    for left, right, score in pairs:
        file.write(json.dumps({"sentence1": vector_text(left), "sentence2": vector_text(right), "score": score}) + "\n")

# The STSBenchmark slice, from the Hub at the revision of the metadata.
from huggingface_hub import hf_hub_download, list_repo_tree

if HUB.exists():
    shutil.rmtree(HUB)
STSB_FOLDER.mkdir(parents=True)
for split, count in [("test", 60), ("train", 5), ("validation", 5)]:
    source = hf_hub_download(STSB_REPO, f"{split}.jsonl.gz", repo_type="dataset", revision=STSB_REVISION)
    with gzip.open(source, "rt", encoding="utf-8") as file:
        lines = file.read().splitlines()[:count]
    if split == "test":
        stsb_gold = [json.loads(line)["score"] for line in lines]
    (STSB_FOLDER / f"{split}.jsonl.gz").write_bytes(gzip.compress(("\n".join(lines) + "\n").encode("utf-8"), mtime=0))
files = sorted(
    entry.path
    for entry in list_repo_tree(STSB_REPO, repo_type="dataset", revision=STSB_REVISION, recursive=True)
    if hasattr(entry, "size") and not hasattr(entry, "tree_id")
)
(HUB / STSB_REPO / f"{STSB_REVISION}.files.json").write_text(json.dumps(files) + "\n", encoding="utf-8")


# JSON has no NaN: a NaN is the string "NaN".
def number(value):
    return "NaN" if math.isnan(value) else value


# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.sts import AbsTaskSTS
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta
    from mteb.tasks.sts.eng.sts_benchmark_sts import STSBenchmarkSTS
    from scipy.stats import pearsonr, rankdata, spearmanr

    class VectorEncoder(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/vector", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            return np.array(
                [[float(value) for value in text.split(" ")] for batch in inputs for text in batch["text"]],
                dtype=np.float32,
            )

    class CodePointEncoder(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/code-points", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            rows = []
            for batch in inputs:
                for text in batch["text"]:
                    vector = np.zeros(CODE_POINT_DIM, dtype=np.float32)
                    for character in text:
                        vector[ord(character) % CODE_POINT_DIM] += 1
                    rows.append(vector)
            return np.stack(rows)

    class FolderTask(AbsTaskSTS):
        min_score = MIN_SCORE
        max_score = MAX_SCORE
        metadata = TaskMetadata(
            name="STSFixture",
            description="The STS fixture of @zukhruf/mteb.",
            dataset={"path": str(FOLDER), "revision": "1"},
            type="STS",
            category="t2t",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="cosine_spearman",
        )

    class STSBenchmarkSlice(STSBenchmarkSTS):
        metadata = STSBenchmarkSTS.metadata.model_copy(
            update={"dataset": {"path": str(STSB_FOLDER), "revision": STSB_REVISION}}
        )

    def run(task, model):
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text())
        return result.task_results[0].scores, predictions

    folder_task = FolderTask()
    folder_scores, folder_predictions = run(folder_task, VectorEncoder())
    stsb_task = STSBenchmarkSlice()
    stsb_scores, stsb_predictions = run(stsb_task, CodePointEncoder())
    stsb_normalized = [stsb_task._normalize(score) for score in stsb_gold]
    normalized = [folder_task._normalize(score) for _, _, score in pairs]

    def correlation_case(case, x, y):
        try:
            pearson = number(float(pearsonr(x, y)[0]))
        except ValueError as error:
            pearson = {"error": str(error)}
        return {
            "case": case,
            "x": [number(v) for v in x],
            "y": [number(v) for v in y],
            "rankdata_x": [number(float(v)) for v in rankdata(x)],
            "rankdata_y": [number(float(v)) for v in rankdata(y)],
            "pearson": pearson,
            "spearman": number(float(spearmanr(x, y)[0])),
        }

    # The first n from 2 where the correlation of two equal rankings, before
    # np.corrcoef clips it, is above 1.
    def above_one(n):
        centred = np.arange(1, n + 1, dtype=np.float64) - (n + 1) / 2
        variance = float(np.dot(centred, centred)) * (1 / (n - 1))
        return variance / math.sqrt(variance) / math.sqrt(variance) > 1

    clip_n = next(n for n in range(2, 1000) if above_one(n))

    def uniform(n, low, high):
        return [rng.uniform(low, high) for _ in range(n)]

    many = [round(rng.uniform(0, 5), 1) for _ in range(300)]
    long_x = uniform(2000, -1, 1)
    correlation_cases = [
        correlation_case("ties in both arrays", [1.0, 2.0, 2.0, 3.0, 3.0, 3.0, 0.0], [0.5, 0.5, 0.1, 0.9, 0.2, 0.2, 0.7]),
        correlation_case("all values tied in pairs", [1.0, 1.0, 2.0, 2.0, 3.0, 3.0], [3.0, 3.0, 1.0, 1.0, 2.0, 2.0]),
        correlation_case("constant x", [0.4, 0.4, 0.4, 0.4], [0.1, 0.9, 0.3, 0.2]),
        correlation_case("constant y", [0.1, 0.9, 0.3, 0.2], [-1.0, -1.0, -1.0, -1.0]),
        correlation_case("negative and zero values", [-0.4, 0.0, -0.0, 0.2, -0.2, 0.6], [-0.5, -0.0, 0.0, 0.3, -0.25, 0.9]),
        correlation_case("two values", [0.2, 0.6], [0.9, 0.1]),
        correlation_case("one value", [0.2], [0.9]),
        correlation_case("a NaN", [0.2, float("nan"), 0.4], [0.9, 0.1, 0.3]),
        correlation_case(f"equal rankings of {clip_n} values", [float(v) for v in range(clip_n)], [float(v) * 2 for v in range(clip_n)]),
        # BLAS ddot adds 3 products in order. In that order, the products of
        # this array with itself, after pearsonr divides it by its norm, add
        # to more than 1.
        correlation_case("3 values with themselves", [7.6, 3.6, 2.6], [7.6, 3.6, 2.6]),
        # In reverse order, these products add to another sum.
        correlation_case("3 values", [7.9, 6.8, 7.4], [1.7, 5.0, 1.5]),
        correlation_case("300 values with ties", many, [round(v + rng.uniform(-1, 1), 1) for v in many]),
        correlation_case("2000 values", long_x, [v * 0.5 + rng.uniform(-0.5, 0.5) for v in long_x]),
    ]

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, torch {VERSIONS['torch']}, "
    f"datasets {VERSIONS['datasets']}, scikit-learn {VERSIONS['scikit-learn']}, "
    f"scipy {VERSIONS['scipy']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "code_point_dim": CODE_POINT_DIM,
            "min_score": MIN_SCORE,
            "max_score": MAX_SCORE,
            "folder": {"scores": folder_scores, "predictions": folder_predictions, "normalized": normalized},
            "stsb": {"scores": stsb_scores, "predictions": stsb_predictions, "gold": stsb_gold, "normalized": stsb_normalized},
            "correlation_cases": correlation_cases,
        },
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(pairs)} folder pairs, {len(correlation_cases)} correlation cases", file=sys.stderr)
