# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "scikit-learn==1.9.1", "scipy==1.18.1"]
# ///
# Makes the classification fixture of classification.golden.test.ts with
# Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/classification/generate.py
#
# It writes:
# - folder/ and binary/: two folder datasets with a train and a test split.
#   Each text is a vector of numbers with spaces between them, which the
#   vector encoder reads as float32 values. folder has 4 classes, binary
#   has the labels 0 and 1.
# - hub/: slices of Banking77 at the revisions of Banking77Classification
#   (train.jsonl and test.jsonl) and of Banking77Classification.v2 (the
#   parquet files of data/, and README.md without the sizes of the full
#   splits), in the cache layout of
#   dependencies/datasets.ts: the rows of the labels 0 to 9, at most 40 of
#   each label in train and 12 in test.
# - expected.json: the max_iter, C and tol of the default evaluator model,
#   and for each task, the undersampling of _undersample_data for
#   each experiment (the shuffled indices and the selected indices), the
#   inputs of each call of the encoder, the scores of mteb.evaluate and the
#   predictions file that it wrote, and the LogisticRegression of each
#   experiment (n_iter_, coef_, intercept_). A NaN score is the string
#   "NaN".
# Never edit these files by hand: run this script again.
#
# The Banking77 runs use the code point encoder: 32 float32 values, where
# the value at k is the share of the code points c of the text with
# c % 32 == k. Shares keep LogisticRegression to a few iterations; with the
# counts themselves it runs to max_iter, and after 100 iterations the last
# bits that BLAS adds in its own order grow to 2% of a coefficient.
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
HUB = HERE / "hub"
BANKING_REPO = "mteb/banking77"
V1_REVISION = "0fd18e25b25c072e09e0d92ab615fda904d66300"
V2_REVISION = "18072d2685ea682290f7b8924d94c62acc19c0b2"
CODE_POINT_DIM = 32

rng = random.Random(3243)


def vector_text(values) -> str:
    return " ".join(repr(float(value)) for value in values)


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


def blob_rows(centers, count, spread):
    rows = []
    for _ in range(count):
        label = rng.randrange(len(centers))
        values = [c + rng.uniform(-spread, spread) for c in centers[label]]
        rows.append({"text": vector_text(values), "label": label})
    return rows


# folder: 4 classes in 6 dimensions, 70 train rows (some classes with fewer
# than 8 + 1 rows), 30 test rows. The blobs overlap a little.
centers = [[rng.uniform(-2, 2) for _ in range(6)] for _ in range(4)]
write_jsonl(HERE / "folder" / "train.jsonl", blob_rows(centers, 70, 1.5))
write_jsonl(HERE / "folder" / "test.jsonl", blob_rows(centers, 30, 1.5))
# binary: 2 classes in 5 dimensions.
centers = [[rng.uniform(-1, 1) for _ in range(5)] for _ in range(2)]
write_jsonl(HERE / "binary" / "train.jsonl", blob_rows(centers, 50, 1.2))
write_jsonl(HERE / "binary" / "test.jsonl", blob_rows(centers, 40, 1.2))

# The Hub slices, at the revisions of the metadata.
import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download, list_repo_tree

if HUB.exists():
    shutil.rmtree(HUB)


def repository_files(revision):
    return sorted(
        entry.path
        for entry in list_repo_tree(BANKING_REPO, repo_type="dataset", revision=revision, recursive=True)
        if hasattr(entry, "size") and not hasattr(entry, "tree_id")
    )


def keep(labels, per_label):
    counts = {}
    kept = []
    for index, label in enumerate(labels):
        if label < 10 and counts.get(label, 0) < per_label:
            counts[label] = counts.get(label, 0) + 1
            kept.append(index)
    return kept


PER_LABEL = {"train": 40, "test": 12}

folder = HUB / BANKING_REPO / V1_REVISION
folder.mkdir(parents=True)
for split, per_label in PER_LABEL.items():
    source = hf_hub_download(BANKING_REPO, f"{split}.jsonl", repo_type="dataset", revision=V1_REVISION)
    rows = [json.loads(line) for line in Path(source).read_text(encoding="utf-8").splitlines()]
    kept = keep([row["label"] for row in rows], per_label)
    write_jsonl(folder / f"{split}.jsonl", [rows[i] for i in kept])
(HUB / BANKING_REPO / f"{V1_REVISION}.files.json").write_text(json.dumps(repository_files(V1_REVISION)) + "\n", encoding="utf-8")

folder = HUB / BANKING_REPO / V2_REVISION
(folder / "data").mkdir(parents=True)
# The card records the sizes of the full splits, which datasets verifies, so
# the slice keeps the card without dataset_info.splits.
card = Path(hf_hub_download(BANKING_REPO, "README.md", repo_type="dataset", revision=V2_REVISION)).read_text(encoding="utf-8")
start = card.index("  splits:\n")
end = card.index("  download_size:", start)
(folder / "README.md").write_text(card[:start] + card[end:], encoding="utf-8")
for split, per_label in PER_LABEL.items():
    name = f"data/{split}-00000-of-00001.parquet"
    table = pq.read_table(hf_hub_download(BANKING_REPO, name, repo_type="dataset", revision=V2_REVISION))
    kept = keep(table.column("label").to_pylist(), per_label)
    pq.write_table(table.take(pa.array(kept)), folder / name)
(HUB / BANKING_REPO / f"{V2_REVISION}.files.json").write_text(json.dumps(repository_files(V2_REVISION)) + "\n", encoding="utf-8")

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.classification import AbsTaskClassification
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta
    from mteb.tasks.classification.eng.banking77_classification import (
        Banking77Classification,
        Banking77ClassificationV2,
    )

    calls = []

    class VectorEncoder(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/vector", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            texts = [text for batch in inputs for text in batch["text"]]
            calls.append({"hf_split": hf_split, "texts": texts})
            return np.array([[float(value) for value in text.split(" ")] for text in texts], dtype=np.float32)

    class CodePointEncoder(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/code-points", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            texts = [text for batch in inputs for text in batch["text"]]
            calls.append({"hf_split": hf_split, "texts": texts})
            rows = []
            for text in texts:
                vector = np.zeros(CODE_POINT_DIM, dtype=np.float32)
                for character in text:
                    vector[ord(character) % CODE_POINT_DIM] += 1
                rows.append(vector / np.float32(len(text)))
            return np.stack(rows)

    fits = []

    # _run_experiment that records the fitted model of each experiment.
    def recorded_experiment(self, train_split, eval_split, train_embeddings, test_embeddings, timer):
        result = AbsTaskClassification._run_experiment(
            self, train_split, eval_split, train_embeddings, test_embeddings, timer
        )
        model = self.evaluator_model
        fits.append({"n_iter": int(model.n_iter_[0]), "coef": model.coef_.tolist(), "intercept": model.intercept_.tolist()})
        return result

    def folder_task(name, path):
        class FolderTask(AbsTaskClassification):
            metadata = TaskMetadata(
                name=name,
                description="The classification fixture of @zukhruf/mteb.",
                dataset={"path": str(path), "revision": "1"},
                type="Classification",
                category="t2c",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=["eng-Latn"],
                main_score="accuracy",
            )

            _run_experiment = recorded_experiment

        return FolderTask()

    def slice_task(task_class, revision):
        class Slice(task_class):
            _run_experiment = recorded_experiment
            metadata = task_class.metadata.model_copy(
                update={"dataset": {"path": str(HUB / BANKING_REPO / revision), "revision": revision}}
            )

        return Slice()

    def undersampling(task):
        task.load_data()
        train = task.dataset["train"] if "train" in task.dataset else task.dataset["default"]["train"]
        experiments = []
        idxs = None
        for i in range(task.n_experiments):
            _, idxs, selected = task._undersample_data(train, i, idxs)
            experiments.append({"idxs": list(idxs), "selected": list(selected)})
        return experiments

    def run(task, model):
        calls.clear()
        fits.clear()
        experiments = undersampling(task)
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text())
        return {
            "undersampling": experiments,
            "encoder_calls": list(calls),
            "scores": result.task_results[0].scores,
            "predictions": predictions,
            "fits": list(fits),
        }

    params = AbsTaskClassification.evaluator_model.get_params()
    expected = {
        "evaluator_model": {key: params[key] for key in ("max_iter", "C", "tol")},
        "folder": run(folder_task("ClassificationFixture", HERE / "folder"), VectorEncoder()),
        "binary": run(folder_task("BinaryClassificationFixture", HERE / "binary"), VectorEncoder()),
        "banking77": run(slice_task(Banking77Classification, V1_REVISION), CodePointEncoder()),
        "banking77_v2": run(slice_task(Banking77ClassificationV2, V2_REVISION), CodePointEncoder()),
    }

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, torch {VERSIONS['torch']}, "
    f"datasets {VERSIONS['datasets']}, scikit-learn {VERSIONS['scikit-learn']}, "
    f"scipy {VERSIONS['scipy']}, CPython {platform.python_version()}"
)


# JSON has no NaN, and tsc reads the fixtures: a NaN score is the string "NaN".
def without_nan(value):
    if isinstance(value, float) and value != value:
        return "NaN"
    if isinstance(value, dict):
        return {key: without_nan(item) for key, item in value.items()}
    if isinstance(value, list):
        return [without_nan(item) for item in value]
    return value


(HERE / "expected.json").write_text(
    json.dumps(
        without_nan({"generator": generator, "code_point_dim": CODE_POINT_DIM, **expected}), indent=1, allow_nan=False
    )
    + "\n",
    encoding="utf-8",
)
print(generator, file=sys.stderr)
for name, value in expected.items():
    if name == "evaluator_model":
        continue
    print(name, value["scores"]["test"][0]["main_score"], [f["n_iter"] for f in value.get("fits", [])], file=sys.stderr)
