# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "scikit-learn==1.9.1", "scipy==1.18.1", "pandas==3.1.0"]
# ///
# Makes the regression fixture of regression.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/regression/generate.py
#
# It writes:
# - folder/ and subsampled/: folder datasets with a train and a test split.
#   Each text is a vector of numbers with spaces between them, which the
#   vector encoder reads as float32 values. In folder/ (150 train rows, 8
#   numbers) each value is a linear function of the vector plus noise,
#   rounded to 0.1, and the task uses all the training rows. In subsampled/
#   (300 train rows, 12 numbers) each value is an int from 0 to 6, mostly 0,
#   so qcut drops equal edges, and the task keeps 100 training rows in each
#   experiment (n_samples). few-train/ has 105 training rows for 100, and
#   one-member/ a bin of one row: MTEB raises for both.
# - hub/: a slice of RuSciBenchCitedCountRegression at the revision of its
#   metadata, in the cache layout of dependencies/datasets.ts: the first 300
#   rows of train and 100 of test of cited_count_ru and cited_count_en, and
#   README.md without the sizes of the full splits. Its task keeps 120
#   training rows in each experiment.
# - expected.json: for each task, the undersampling of each experiment
#   (_undersample_data: the selected indices, in order) from a task of its
#   own, the split, number and sha256 of the texts of each call of the
#   encoder, the scores of mteb.evaluate
#   and the predictions file that it wrote, coef_ and intercept_ of each fit,
#   and the scores of a second mteb.evaluate of the same task; the errors of
#   few-train/ and one-member/; and the rows of stratified_subsampling of
#   three test splits, or its error for a constant value.
# Never edit these files by hand: run this script again.
#
# The hub slice uses the code point count encoder: 32 float32 values, where
# the value at k is the number of the code points c of the text with
# c % 32 == k. Shares of the code points would add up to 1 in each row, and
# the centred rows would then lose a rank, which LAPACK libraries do not
# treat alike. Each fit checks that the centred rows have full rank and a
# smallest singular value above 1e-4 of the largest, and the predictions of
# each experiment differ by more than 2^-16 of their size, unless their
# embeddings are equal.
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

VERSIONS = {
    "mteb": "2.26.28",
    "numpy": "2.5.4",
    "torch": "2.14.1",
    "datasets": "5.1.0",
    "scikit-learn": "1.9.1",
    "scipy": "1.18.1",
    "pandas": "3.1.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
HUB = HERE / "hub"
REPO = "mlsa-iai-msu-lab/ru_sci_bench_mteb"
REVISION = "fbc0599a0b5f00b3c7d87ab4d13490f04fb77f8e"
SUBSETS = ["cited_count_ru", "cited_count_en"]
CODE_POINT_DIM = 32
rng = np.random.default_rng(3243)
warnings.simplefilter("ignore")


def vector_text(values) -> str:
    return " ".join(repr(float(value)) for value in values)


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


def linear_rows(count, weights):
    rows = []
    for _ in range(count):
        vector = rng.normal(size=len(weights))
        value = round(float(vector @ weights + rng.normal() * 0.5), 1)
        rows.append({"text": vector_text(vector), "value": value})
    return rows


def zero_heavy_rows(count, dims):
    rows = []
    for _ in range(count):
        value = int(min(6, np.floor(rng.exponential(0.8))))
        vector = rng.normal(size=dims) * 0.5 + value
        rows.append({"text": vector_text(vector), "value": value})
    return rows


weights = rng.normal(size=8)
write_jsonl(HERE / "folder" / "train.jsonl", linear_rows(150, weights))
write_jsonl(HERE / "folder" / "test.jsonl", linear_rows(60, weights))
write_jsonl(HERE / "subsampled" / "train.jsonl", zero_heavy_rows(300, 12))
write_jsonl(HERE / "subsampled" / "test.jsonl", zero_heavy_rows(40, 12))
write_jsonl(HERE / "few-train" / "train.jsonl", linear_rows(105, weights))
write_jsonl(HERE / "few-train" / "test.jsonl", linear_rows(20, weights))


# A training split whose qcut gives a bin of one row.
def has_single_bin(values):
    counts = pd.Series(pd.qcut(values, q=10, labels=False, duplicates="drop")).value_counts()
    return counts.min() == 1


search = np.random.default_rng(7)
while True:
    values = [int(value) for value in np.floor(search.exponential(1.5, 110))]
    if has_single_bin(values):
        break
write_jsonl(
    HERE / "one-member" / "train.jsonl",
    [{"text": vector_text(rng.normal(size=8)), "value": value} for value in values],
)
write_jsonl(HERE / "one-member" / "test.jsonl", zero_heavy_rows(20, 8))

# The Hub slice, at the revision of the metadata.
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download, list_repo_tree

if HUB.exists():
    shutil.rmtree(HUB)
folder = HUB / REPO / REVISION
folder.mkdir(parents=True)
# The card records the sizes of the full splits, which datasets verifies, so
# the slice keeps the card without the splits and sizes of dataset_info.
card = Path(hf_hub_download(REPO, "README.md", repo_type="dataset", revision=REVISION)).read_text(encoding="utf-8")
sizes = re.compile(r"  splits:\n(?:  - .*\n|    .*\n)*  download_size: \d+\n  dataset_size: \d+\n")
assert len(sizes.findall(card)) == 12, len(sizes.findall(card))
(folder / "README.md").write_text(sizes.sub("", card), encoding="utf-8")
for subset in SUBSETS:
    (folder / subset).mkdir()
    for split, count in {"train": 300, "test": 100}.items():
        name = f"{subset}/{split}-00000-of-00001.parquet"
        full = hf_hub_download(REPO, name, repo_type="dataset", revision=REVISION)
        pq.write_table(pq.read_table(full).slice(0, count), folder / name)
files = sorted(
    entry.path
    for entry in list_repo_tree(REPO, repo_type="dataset", revision=REVISION, recursive=True)
    if hasattr(entry, "size") and not hasattr(entry, "tree_id")
)
(HUB / REPO / f"{REVISION}.files.json").write_text(json.dumps(files) + "\n", encoding="utf-8")

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import datasets
    import mteb
    from sklearn.linear_model import LinearRegression

    from mteb.abstasks.regression import AbsTaskRegression
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta
    from mteb.tasks.regression.multilingual.ru_sci_bench_regression import RuSciBenchCitedCountRegression

    datasets.disable_progress_bars()

    # A call of the encoder: its split, the number of its texts and the
    # sha256 of the texts joined by NUL characters, which keeps the Hub texts
    # out of this file.
    def encoder_call(hf_split, texts):
        digest = hashlib.sha256("\0".join(texts).encode("utf-8")).hexdigest()
        return {"hf_split": hf_split, "count": len(texts), "sha256": digest}

    calls = []
    fits = []

    class VectorEncoder(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/vector", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            texts = [text for batch in inputs for text in batch["text"]]
            calls.append(encoder_call(hf_split, texts))
            return np.array([[float(value) for value in text.split(" ")] for text in texts], dtype=np.float32)

    class CodePointCountEncoder(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(overwrites={"name": "test/code-point-counts", "revision": "1"})

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            texts = [text for batch in inputs for text in batch["text"]]
            calls.append(encoder_call(hf_split, texts))
            rows = []
            for text in texts:
                vector = np.zeros(CODE_POINT_DIM, dtype=np.float32)
                for character in text:
                    vector[ord(character) % CODE_POINT_DIM] += 1
                rows.append(vector)
            return np.stack(rows)

    # A LinearRegression that keeps each fit and checks the rules above.
    class RecordingLinearRegression(LinearRegression):
        def fit(self, X, y, sample_weight=None):
            super().fit(X, y, sample_weight)
            assert self.rank_ == X.shape[1], self.rank_
            assert self.singular_[-1] / self.singular_[0] > 1e-4, self.singular_[-1] / self.singular_[0]
            fits.append({"coef": [float(value) for value in self.coef_], "intercept": float(self.intercept_)})
            return self

        def predict(self, X):
            predictions = super().predict(X)
            order = np.argsort(predictions, kind="stable")
            for a, b in zip(order[:-1], order[1:]):
                low, high = float(predictions[a]), float(predictions[b])
                if low == high:
                    assert np.array_equal(X[a], X[b]), (low, a, b)
                else:
                    assert (high - low) / max(1.0, abs(high)) > 2**-16, (low, high)
            return predictions

    def folder_task(name, path, n_samples=2048):
        class FolderTask(AbsTaskRegression):
            metadata = TaskMetadata(
                name=name,
                description="The regression fixture of @zukhruf/mteb.",
                dataset={"path": str(path), "revision": "1"},
                type="Regression",
                category="t2c",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=["eng-Latn"],
                main_score="kendalltau",
            )

        task = FolderTask()
        task.n_samples = n_samples
        task.evaluator_model = RecordingLinearRegression()
        return task

    def slice_task():
        class Slice(RuSciBenchCitedCountRegression):
            metadata = RuSciBenchCitedCountRegression.metadata.model_copy(
                update={"dataset": {"path": str(HUB / REPO / REVISION), "revision": REVISION}}
            )

        task = Slice()
        task.n_samples = 120
        task.evaluator_model = RecordingLinearRegression()
        return task

    def undersampling(task):
        task.load_data()
        trains = (
            {"default": task.dataset["train"]}
            if "train" in task.dataset
            else {subset: task.dataset[subset]["train"] for subset in task.hf_subsets}
        )
        return {
            subset: [
                [int(i) for i in task._undersample_data(train, i, None)[2]] for i in range(task.n_experiments)
            ]
            for subset, train in trains.items()
        }

    def run(make_task, model):
        experiments = undersampling(make_task())
        task = make_task()
        calls.clear()
        fits.clear()
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text())
        encoder_calls = list(calls)
        task_fits = list(fits)
        second = mteb.evaluate(model, task, cache=None, overwrite_strategy="always")
        return {
            "undersampling": experiments,
            "encoder_calls": encoder_calls,
            "scores": result.task_results[0].scores,
            "predictions": predictions,
            "fits": task_fits,
            "second_scores": second.task_results[0].scores,
        }

    def error_of(task):
        try:
            mteb.evaluate(VectorEncoder(), task, cache=None)
        except ValueError as error:
            return str(error)
        raise AssertionError(f"{task.metadata.name} did not raise.")

    def subsampling_case(name, values, n_samples, seed):
        values = list(values)
        dataset = datasets.Dataset.from_dict({"text": [f"row {i}" for i in range(len(values))], "value": values})
        case = {"case": name, "values": values, "n_samples": n_samples, "seed": seed}
        try:
            result = AbsTaskRegression.stratified_subsampling(
                datasets.DatasetDict({"test": dataset}), seed=seed, n_samples=n_samples
            )
            case["rows"] = result["test"].to_list()
        except Exception as error:
            case["error"] = str(error)
        return case

    expected = {
        "folder": run(lambda: folder_task("RegressionFixture", HERE / "folder"), VectorEncoder()),
        "subsampled": run(lambda: folder_task("SubsampledRegressionFixture", HERE / "subsampled", 100), VectorEncoder()),
        "hub": run(slice_task, CodePointCountEncoder()),
        "few_train_error": error_of(folder_task("FewTrainRegressionFixture", HERE / "few-train", 100)),
        "one_member_error": error_of(folder_task("OneMemberRegressionFixture", HERE / "one-member", 100)),
        "stratified_subsampling": [
            subsampling_case("floats", [float(value) for value in rng.normal(size=300)], 100, 42),
            subsampling_case("ints with many zeros", [int(value) for value in np.floor(rng.exponential(2, 250))], 80, 43),
            subsampling_case("no subsampling for n_samples >= rows", [1, 2, 3, 4, 5], 5, 44),
            subsampling_case("a constant", [3] * 30, 10, 45),
        ],
    }

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, torch {VERSIONS['torch']}, "
    f"datasets {VERSIONS['datasets']}, scikit-learn {VERSIONS['scikit-learn']}, scipy {VERSIONS['scipy']}, "
    f"pandas {VERSIONS['pandas']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "code_point_dim": CODE_POINT_DIM, **expected}, indent=1, allow_nan=False)
    + "\n",
    encoding="utf-8",
)
print(generator, file=sys.stderr)
for name in ("folder", "subsampled", "hub"):
    print(name, [s["main_score"] for s in expected[name]["scores"]["test"]], file=sys.stderr)
print("few-train", expected["few_train_error"], file=sys.stderr)
print("one-member", expected["one_member_error"], file=sys.stderr)
