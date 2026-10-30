# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "scikit-learn==1.9.1", "scipy==1.18.1"]
# ///
# Makes the multilabel classification fixture of
# multilabel-classification.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/multilabel-classification/generate.py
#
# It writes:
# - folder/ and subsampled/: folder datasets with a train and a test split.
#   Each text is a vector of 20 numbers with spaces between them, which the
#   vector encoder reads as float32 values, and each label is a list of 0 to
#   2 of 6 labels. subsampled/ has 90 test rows, and its task keeps 40 of
#   them (max_eval_samples), by iterative stratification. single/ has one
#   label only, and MTEB raises for it.
# - hub/: a slice of KorHateSpeechMLClassification at the revision of its
#   metadata, in the cache layout of dependencies/datasets.ts: the first 400
#   rows of train, 150 of test and 20 of validation (the parquet files of
#   data/), and README.md without the sizes of the full splits.
# - expected.json: for each task, the undersampling of each experiment
#   (_undersample_data_indices: the selected and the shuffled indices) from a
#   task of its own, the inputs of each call of the encoder, the scores of
#   mteb.evaluate and the predictions file that it wrote, and the scores of
#   a second mteb.evaluate of the same task, whose shuffles go on from the
#   first one's; and the error of the single task.
# Never edit these files by hand: run this script again.
#
# The Kor slice uses the code point encoder: 32 float32 values, where the
# value at k is the share of the code points c of the text with
# c % 32 == k.
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
KOR_REPO = "mteb/KorHateSpeechMLClassification"
KOR_REVISION = "47cd2e61b64f2f11ccb006a579cda71318c6de9b"
CODE_POINT_DIM = 32
DIMS = 20
N_LABELS = 6

rng = random.Random(3243)


def vector_text(values) -> str:
    return " ".join(repr(float(value)) for value in values)


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


centers = [[rng.uniform(-1, 1) for _ in range(DIMS)] for _ in range(N_LABELS)]


def blob_rows(count):
    rows = []
    for _ in range(count):
        labels = sorted(rng.sample(range(N_LABELS), rng.choice([0, 1, 1, 1, 2])))
        base = [sum(centers[label][k] for label in labels) / len(labels) if labels else 0.0 for k in range(DIMS)]
        rows.append({"text": vector_text([value + rng.uniform(-0.5, 0.5) for value in base]), "label": labels})
    return rows


write_jsonl(HERE / "folder" / "train.jsonl", blob_rows(150))
write_jsonl(HERE / "folder" / "test.jsonl", blob_rows(60))
write_jsonl(HERE / "subsampled" / "train.jsonl", blob_rows(120))
write_jsonl(HERE / "subsampled" / "test.jsonl", blob_rows(90))
write_jsonl(HERE / "single" / "train.jsonl", [{**row, "label": [0]} for row in blob_rows(30)])
write_jsonl(HERE / "single" / "test.jsonl", [{**row, "label": [0]} for row in blob_rows(10)])

# The Hub slice, at the revision of the metadata.
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download, list_repo_tree

if HUB.exists():
    shutil.rmtree(HUB)
folder = HUB / KOR_REPO / KOR_REVISION
(folder / "data").mkdir(parents=True)
# The card records the sizes of the full splits, which datasets verifies, so
# the slice keeps the card without dataset_info.splits.
card = Path(hf_hub_download(KOR_REPO, "README.md", repo_type="dataset", revision=KOR_REVISION)).read_text(encoding="utf-8")
start = card.index("  splits:\n")
end = card.index("  download_size:", start)
(folder / "README.md").write_text(card[:start] + card[end:], encoding="utf-8")
for split, count in {"train": 400, "test": 150, "validation": 20}.items():
    name = f"data/{split}-00000-of-00001.parquet"
    table = pq.read_table(hf_hub_download(KOR_REPO, name, repo_type="dataset", revision=KOR_REVISION))
    pq.write_table(table.slice(0, count), folder / name)
files = sorted(
    entry.path
    for entry in list_repo_tree(KOR_REPO, repo_type="dataset", revision=KOR_REVISION, recursive=True)
    if hasattr(entry, "size") and not hasattr(entry, "tree_id")
)
(HUB / KOR_REPO / f"{KOR_REVISION}.files.json").write_text(json.dumps(files) + "\n", encoding="utf-8")

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.multilabel_classification import AbsTaskMultilabelClassification
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta
    from mteb.tasks.multilabel_classification.kor.kor_hate_speech_ml_classification import (
        KorHateSpeechMLClassification,
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

    def folder_task(name, path, max_eval_samples=3000):
        class FolderTask(AbsTaskMultilabelClassification):
            metadata = TaskMetadata(
                name=name,
                description="The multilabel classification fixture of @zukhruf/mteb.",
                dataset={"path": str(path), "revision": "1"},
                type="MultilabelClassification",
                category="t2c",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=["eng-Latn"],
                main_score="accuracy",
            )

        task = FolderTask()
        task.max_eval_samples = max_eval_samples
        return task

    def slice_task():
        class Slice(KorHateSpeechMLClassification):
            metadata = KorHateSpeechMLClassification.metadata.model_copy(
                update={"dataset": {"path": str(HUB / KOR_REPO / KOR_REVISION), "revision": KOR_REVISION}}
            )

        return Slice()

    def undersampling(task):
        task.load_data()
        train = task.dataset["train"] if "train" in task.dataset else task.dataset["default"]["train"]
        experiments = []
        for _ in range(task.n_experiments):
            selected, idxs = task._undersample_data_indices(train[task.label_column_name], task.samples_per_label, None)
            experiments.append({"sample_indices": [int(i) for i in selected], "idxs": [int(i) for i in idxs]})
        return experiments

    def run(make_task, model):
        experiments = undersampling(make_task())
        task = make_task()
        calls.clear()
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text())
        encoder_calls = list(calls)
        second = mteb.evaluate(model, task, cache=None, overwrite_strategy="always")
        return {
            "undersampling": experiments,
            "encoder_calls": encoder_calls,
            "scores": result.task_results[0].scores,
            "predictions": predictions,
            "second_scores": second.task_results[0].scores,
        }

    expected = {
        "folder": run(lambda: folder_task("MultilabelFixture", HERE / "folder"), VectorEncoder()),
        "subsampled": run(lambda: folder_task("SubsampledMultilabelFixture", HERE / "subsampled", 40), VectorEncoder()),
        "kor": run(slice_task, CodePointEncoder()),
    }
    try:
        mteb.evaluate(VectorEncoder(), folder_task("SingleLabelFixture", HERE / "single"), cache=None)
        raise AssertionError("The single task did not raise.")
    except ValueError as error:
        expected["single_error"] = str(error)

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, torch {VERSIONS['torch']}, "
    f"datasets {VERSIONS['datasets']}, scikit-learn {VERSIONS['scikit-learn']}, "
    f"scipy {VERSIONS['scipy']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "code_point_dim": CODE_POINT_DIM, **expected}, indent=1, allow_nan=False)
    + "\n",
    encoding="utf-8",
)
print(generator, file=sys.stderr)
for name in ("folder", "subsampled", "kor"):
    print(name, expected[name]["scores"]["test"][0]["main_score"], expected[name]["second_scores"]["test"][0]["main_score"], file=sys.stderr)
print("single", expected["single_error"], file=sys.stderr)
