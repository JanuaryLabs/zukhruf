# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "scikit-learn==1.9.1", "scipy==1.18.1"]
# ///
# Makes the pair classification fixture of pair-classification.golden.test.ts
# and sprint-duplicate-questions-pc.test.ts with Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/pair-classification/generate.py
#
# It writes:
# - folder/test.jsonl: a folder dataset of pairs. Each text is a vector of
#   136 numbers with spaces between them. The vector encoder reads the text as a
#   float32 vector.
# - hub/: a slice of SprintDuplicateQuestions at the revision of its
#   metadata, in the cache layout of dependencies/datasets.ts: the first 20
#   positive and 40 negative pairs of test.json.gz, and 5 and 5 of
#   validation.json.gz, in MTEB's v1 format (one row of lists).
# - expected.json: for each of the two tasks, the scores of mteb.evaluate and
#   the predictions file that it wrote; for the folder task, the best
#   accuracy and F1 with their thresholds for each score array of the
#   predictions; and the metrics of _compute_metrics_values for score arrays
#   made here.
# Never edit these files by hand: run this script again.
#
# The Sprint run uses the code point encoder: 8 values, where the value at k
# is the number of code points c of the text with c % 8 == k.
import gzip
import importlib.metadata
import json
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
SPRINT_REPO = "mteb/sprintduplicatequestions-pairclassification"
SPRINT_REVISION = "d66bd1f72af766a5cc4b0ca5e00c162f89e8cc46"
HUB = HERE / "hub"
SPRINT_FOLDER = HUB / SPRINT_REPO / SPRINT_REVISION
CODE_POINT_DIM = 8

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


# The pairs of the folder task: (vector 1, vector 2, label).
pairs = [
    # Equal vectors: cosine 1, distances 0.
    ([1, 2, 3, 4], [1, 2, 3, 4], 1),
    # A zero vector: sklearn's normalize keeps it zero, torch divides by 1e-12.
    ([0, 0, 0, 0], [1, 1, 0, 0], 0),
    # Opposite vectors: negative cosine and dot product.
    ([1, -1, 2, 0], [-1, 1, -2, 0], 0),
    # The same pair three times with both labels: tied scores.
    ([0.1, 0.2, 0.3, 0.4], [0.3, 0.1, 0.2, 0.7], 1),
    ([0.1, 0.2, 0.3, 0.4], [0.3, 0.1, 0.2, 0.7], 0),
    ([0.1, 0.2, 0.3, 0.4], [0.3, 0.1, 0.2, 0.7], 1),
    # Powers of two: every float32 operation is exact.
    ([1, 1, 1, 1], [1, -1, 1, 1], 1),
    ([2, 0, 0, 0], [0, 2, 0, 0], 0),
    # A norm below 10 * eps of float32: sklearn's normalize keeps the row.
    ([1e-7, 0, 0, 0], [1, 0, 0, 0], 1),
]
pairs = [(padded(left), padded(right), label) for left, right, label in pairs]
pairs += [(random_vector(), random_vector(), rng.randint(0, 1)) for _ in range(28)]

FOLDER.mkdir(exist_ok=True)
with (FOLDER / "test.jsonl").open("w", encoding="utf-8") as file:
    for left, right, label in pairs:
        file.write(json.dumps({"sentence1": vector_text(left), "sentence2": vector_text(right), "labels": label}) + "\n")

# The Sprint slice, from the Hub at the revision of the metadata.
from huggingface_hub import hf_hub_download, list_repo_tree

if HUB.exists():
    shutil.rmtree(HUB)
SPRINT_FOLDER.mkdir(parents=True)
for split, positives, negatives in [("test", 20, 40), ("validation", 5, 5)]:
    source = hf_hub_download(SPRINT_REPO, f"{split}.json.gz", repo_type="dataset", revision=SPRINT_REVISION)
    with gzip.open(source, "rt", encoding="utf-8") as file:
        (line,) = file.read().splitlines()
    full = json.loads(line)
    labels = full["labels"]
    keep = [i for i, label in enumerate(labels) if label == 1][:positives]
    keep += [i for i, label in enumerate(labels) if label == 0][:negatives]
    row = {column: [values[i] for i in keep] for column, values in full.items()}
    (SPRINT_FOLDER / f"{split}.json.gz").write_bytes(
        gzip.compress((json.dumps(row) + "\n").encode("utf-8"), mtime=0)
    )
files = sorted(
    entry.path
    for entry in list_repo_tree(SPRINT_REPO, repo_type="dataset", revision=SPRINT_REVISION, recursive=True)
    if hasattr(entry, "size") and not hasattr(entry, "tree_id")
)
(HUB / SPRINT_REPO / f"{SPRINT_REVISION}.files.json").write_text(json.dumps(files) + "\n", encoding="utf-8")

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.pair_classification import AbsTaskPairClassification
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta
    from mteb.tasks.pair_classification.eng.sprint_duplicate_questions_pc import SprintDuplicateQuestionsPC

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

    class FolderTask(AbsTaskPairClassification):
        metadata = TaskMetadata(
            name="PairFixture",
            description="The pair classification fixture of @zukhruf/mteb.",
            dataset={"path": str(FOLDER), "revision": "1"},
            type="PairClassification",
            category="t2t",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="max_ap",
        )

    class SprintSlice(SprintDuplicateQuestionsPC):
        metadata = SprintDuplicateQuestionsPC.metadata.model_copy(
            update={"dataset": {"path": str(SPRINT_FOLDER), "revision": SPRINT_REVISION}}
        )

    def run(task, model):
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text())
        return result.task_results[0].scores, predictions

    folder_task = FolderTask()
    folder_scores, folder_predictions = run(folder_task, VectorEncoder())
    sprint_scores, sprint_predictions = run(SprintSlice(), CodePointEncoder())

    labels = np.asarray([label for _, _, label in pairs], dtype=np.int64)
    thresholds = {}
    for name, reverse in [
        ("similarity_scores", True),
        ("cosine_scores", True),
        ("manhattan_distances", False),
        ("euclidean_distances", False),
        ("dot_scores", True),
    ]:
        scores = folder_predictions["default"]["test"][name]
        thresholds[name] = {
            "accuracy": list(folder_task._find_best_acc_and_threshold(scores, labels, reverse)),
            "f1": list(folder_task._find_best_f1_and_threshold(scores, labels, reverse)),
        }

    def metric_case(case, scores, case_labels):
        case_labels = np.asarray(case_labels, dtype=np.int64)
        results = {}
        for reverse in (True, False):
            results["high" if reverse else "low"] = {
                "metrics": folder_task._compute_metrics_values(scores, case_labels, reverse),
                "accuracy": [float(v) for v in folder_task._find_best_acc_and_threshold(scores, case_labels, reverse)],
                "f1": [float(v) for v in folder_task._find_best_f1_and_threshold(scores, case_labels, reverse)],
            }
        return {"case": case, "scores": scores, "labels": case_labels.tolist(), **results}

    many = [round(rng.uniform(-1, 1), 2) for _ in range(300)]
    metric_cases = [
        metric_case("all scores equal", [0.5] * 6, [1, 0, 1, 0, 0, 1]),
        metric_case("no positive label", [0.9, 0.1, 0.4, 0.3], [0, 0, 0, 0]),
        metric_case("no negative label", [0.9, 0.1, 0.4, 0.3], [1, 1, 1, 1]),
        metric_case("one pair", [0.25], [1]),
        metric_case("ties at the best threshold", [0.9, 0.8, 0.8, 0.8, 0.2, 0.1], [1, 1, 0, 1, 0, 0]),
        metric_case("negative zero and zero", [0.0, -0.0, 0.5, -0.5], [1, 0, 1, 0]),
        metric_case("300 scores with ties", many, [rng.randint(0, 1) for _ in many]),
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
            "folder": {"scores": folder_scores, "predictions": folder_predictions, "thresholds": thresholds},
            "sprint": {"scores": sprint_scores, "predictions": sprint_predictions},
            "metric_cases": metric_cases,
        },
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(pairs)} folder pairs, {len(metric_cases)} metric cases", file=sys.stderr)
