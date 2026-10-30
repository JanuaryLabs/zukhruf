# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "scikit-learn==1.9.1", "scipy==1.18.1"]
# ///
# Makes the clustering fixture of clustering.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/abstasks/fixtures/clustering/generate.py
#
# It writes:
# - folder/test.jsonl, strings/test.jsonl and legacy/test.jsonl: three
#   folder datasets. Each text is a vector of numbers with spaces between
#   them, which the vector encoder reads as float32 values. folder has int
#   labels at two levels, and some rows have only the first level. strings has
#   string labels at two levels, and some rows have only the first level.
#   legacy has three sets of inputs: two with clusters, one with one label.
# - hub/: slices of BiorxivClusteringS2S.v2 (the first 1000 rows of
#   test.jsonl.gz, and its README.md) and of BiorxivClusteringS2S (the first
#   600 inputs of set 0, more than the batch of 500 of the legacy evaluator,
#   the first 150 of set 1 and the first input of set 5), in the cache layout
#   of dependencies/datasets.ts.
# - expected.json: the scores of mteb.evaluate and its predictions file for
#   each task (for a v2 task, each run of cluster labels as a string of
#   base-36 digits); v_measure_score, homogeneity_completeness_v_measure and
#   adjusted_mutual_info_score of label arrays made here; MiniBatchKMeans of
#   data made here (labels, centers, steps); and math.log of the integers
#   1 to 16384 (float64, little-endian, base64), with the integers whose
#   log is not the correctly rounded one and that correctly rounded value.
# Never edit these files by hand: run this script again.
#
# The Biorxiv runs use the code point encoder: 16 values, where the value at
# k is the number of code points c of the text with c % 16 == k.
import base64
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
from decimal import Decimal, getcontext
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
BIORXIV_REPO = "mteb/biorxiv-clustering-s2s"
V2_REVISION = "eb4edb10386758d274cd161093eb351381a16dbf"
LEGACY_REVISION = "258694dd0231531bc1fd9de6ceb52a0853c6d908"
CODE_POINT_DIM = 16

rng = random.Random(3243)


def vector_text(values) -> str:
    return " ".join(repr(float(value)) for value in values)


def blob(center, spread):
    return [c + rng.randint(-spread, spread) for c in center]


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


# folder: 4 groups at level 0, each with 2 subgroups at level 1. Each
# subgroup is a blob of integers around its center, far from the others.
groups = [[rng.randint(-60, 60) for _ in range(6)] for _ in range(4)]
folder_rows = []
for index in range(120):
    group = rng.randrange(4)
    sub = rng.randrange(2)
    center = [c + (12 if sub else -12) * (1 if k % 2 else -1) for k, c in enumerate(groups[group])]
    labels = [group] if index % 6 == 0 else [group, 10 * group + sub]
    folder_rows.append({"sentences": vector_text(blob(center, 2)), "labels": labels})
write_jsonl(HERE / "folder" / "test.jsonl", folder_rows)

# strings: string labels whose code point order is not their UTF-16 order.
names = ["Zeta", "alpha", "é", "\U0001d538", "Ａ"]
string_rows = []
for index in range(60):
    group = rng.randrange(len(names))
    center = [40 * group * (1 if k % 2 else -1) for k in range(5)]
    labels = [names[group]] if index % 5 == 0 else [names[group], names[group] + "/" + str(index % 2)]
    string_rows.append({"sentences": vector_text(blob(center, 3)), "labels": labels})
write_jsonl(HERE / "strings" / "test.jsonl", string_rows)

# legacy: each row is a set of inputs to cluster.
legacy_rows = []
for n_inputs, n_blobs in [(80, 4), (40, 3), (6, 1)]:
    centers = [[rng.randint(-50, 50) for _ in range(5)] for _ in range(n_blobs)]
    members = [rng.randrange(n_blobs) for _ in range(n_inputs)]
    legacy_rows.append(
        {
            "sentences": [vector_text(blob(centers[m], 2)) for m in members],
            "labels": [f"blob {m}" for m in members],
        }
    )
write_jsonl(HERE / "legacy" / "test.jsonl", legacy_rows)

# The Hub slices, at the revisions of the metadata.
from huggingface_hub import hf_hub_download, list_repo_tree

if HUB.exists():
    shutil.rmtree(HUB)


def repository_files(revision):
    return sorted(
        entry.path
        for entry in list_repo_tree(BIORXIV_REPO, repo_type="dataset", revision=revision, recursive=True)
        if hasattr(entry, "size") and not hasattr(entry, "tree_id")
    )


def write_slice(revision, lines, copy=()):
    folder = HUB / BIORXIV_REPO / revision
    folder.mkdir(parents=True)
    (folder / "test.jsonl.gz").write_bytes(gzip.compress(("\n".join(lines) + "\n").encode("utf-8"), mtime=0))
    for name in copy:
        shutil.copyfile(hf_hub_download(BIORXIV_REPO, name, repo_type="dataset", revision=revision), folder / name)
    (HUB / BIORXIV_REPO / f"{revision}.files.json").write_text(json.dumps(repository_files(revision)) + "\n", encoding="utf-8")


with gzip.open(hf_hub_download(BIORXIV_REPO, "test.jsonl.gz", repo_type="dataset", revision=V2_REVISION), "rt", encoding="utf-8") as file:
    write_slice(V2_REVISION, file.read().splitlines()[:1000], copy=["README.md"])
with gzip.open(hf_hub_download(BIORXIV_REPO, "test.jsonl.gz", repo_type="dataset", revision=LEGACY_REVISION), "rt", encoding="utf-8") as file:
    sets = [json.loads(line) for line in file.read().splitlines()]
legacy_slice = []
for index, count in [(0, 600), (1, 150), (5, 1)]:
    legacy_slice.append(json.dumps({key: values[:count] for key, values in sets[index].items()}, ensure_ascii=False))
write_slice(LEGACY_REVISION, legacy_slice)

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.clustering import AbsTaskClustering
    from mteb.abstasks.clustering_legacy import AbsTaskClusteringLegacy
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta
    from mteb.tasks.clustering.eng.biorxiv_clustering_s2s import BiorxivClusteringS2S, BiorxivClusteringS2SFast
    from sklearn.cluster import MiniBatchKMeans
    from sklearn.metrics.cluster import (
        adjusted_mutual_info_score,
        homogeneity_completeness_v_measure,
        v_measure_score,
    )

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

    def metadata(name, folder):
        return TaskMetadata(
            name=name,
            description="The clustering fixture of @zukhruf/mteb.",
            dataset={"path": str(HERE / folder), "revision": "1"},
            type="Clustering",
            category="t2c",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="v_measure",
        )

    class FolderTask(AbsTaskClustering):
        max_fraction_of_documents_to_embed = 0.5
        max_documents_per_cluster = 1000
        n_clusters = 3
        metadata = metadata("ClusteringFixture", "folder")

    class StringsTask(AbsTaskClustering):
        max_fraction_of_documents_to_embed = None
        max_document_to_embed = 30
        max_documents_per_cluster = 500
        n_clusters = 2
        metadata = metadata("ClusteringStringsFixture", "strings")

    class LegacyTask(AbsTaskClusteringLegacy):
        metadata = metadata("ClusteringLegacyFixture", "legacy")

    def at_hub(task_class, revision):
        class Slice(task_class):
            metadata = task_class.metadata.model_copy(
                update={"dataset": {"path": str(HUB / BIORXIV_REPO / revision), "revision": revision}}
            )

        return Slice

    def run(task, model):
        with tempfile.TemporaryDirectory() as folder:
            result = mteb.evaluate(model, task, cache=None, prediction_folder=folder)
            predictions = json.loads((Path(folder) / f"{task.metadata.name}_predictions.json").read_text())
        return {"scores": result.task_results[0].scores, "predictions": predictions}

    # The cluster labels of each run of a v2 task, one base-36 digit each.
    def compact(predictions):
        return {
            subset: {
                split: {level: ["".join(np.base_repr(label, 36) for label in run) for run in runs] for level, runs in levels.items()}
                for split, levels in splits.items()
            }
            for subset, splits in predictions.items()
            if subset != "mteb_model_meta"
        }

    tasks = {
        "folder": run(FolderTask(), VectorEncoder()),
        "strings": run(StringsTask(), VectorEncoder()),
        "legacy": run(LegacyTask(), VectorEncoder()),
        "biorxiv_v2": run(at_hub(BiorxivClusteringS2SFast, V2_REVISION)(), CodePointEncoder()),
        "biorxiv_legacy": run(at_hub(BiorxivClusteringS2S, LEGACY_REVISION)(), CodePointEncoder()),
    }

    for name in ["folder", "strings", "biorxiv_v2"]:
        tasks[name]["predictions"] = compact(tasks[name]["predictions"])

    def metric_case(case, labels_true, labels_pred):
        homogeneity, completeness, v_measure = homogeneity_completeness_v_measure(labels_true, labels_pred)
        return {
            "case": case,
            "labels_true": labels_true,
            "labels_pred": labels_pred,
            "homogeneity": homogeneity,
            "completeness": completeness,
            "v_measure": float(v_measure_score(labels_true, labels_pred)),
            "ami": float(adjusted_mutual_info_score(labels_true, labels_pred)),
        }

    def random_labels(n, k):
        return [rng.randrange(k) for _ in range(n)]

    big_true = random_labels(4096, 26)
    big_pred = [label if rng.random() < 0.6 else rng.randrange(20) for label in big_true]
    metric_cases = [
        metric_case("one cluster", [0, 1, 2, 1, 0], [3, 3, 3, 3, 3]),
        metric_case("one class", [7, 7, 7, 7], [0, 1, 0, 2]),
        metric_case("one class and one cluster", [1, 1, 1], [0, 0, 0]),
        metric_case("all singletons", [0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0]),
        metric_case("empty", [], []),
        metric_case("a perfect match with other names", [2, 2, 0, 0, 1], [0, 0, 1, 1, 9]),
        metric_case("strings in code point order", ["Zeta", "alpha", "é", "\U0001d538", "Ａ", "é", "alpha"], [0, 1, 1, 2, 2, 0, 1]),
        metric_case("negative labels", [-1, -1, 3, 3, -5], [1, 0, 1, 0, 1]),
        metric_case("1000 samples of 20 classes", random_labels(1000, 20), random_labels(1000, 20)),
        metric_case("4096 samples, 26 classes and 20 clusters", big_true, big_pred),
    ]

    def kmeans_case(case, x, n_clusters, batch_size, n_init):
        x = np.asarray(x, dtype=np.float32)
        model = MiniBatchKMeans(n_clusters=n_clusters, batch_size=batch_size, n_init=n_init, init="k-means++", random_state=42)
        model.fit(x)
        return {
            "case": case,
            "x": x.tolist(),
            "n_clusters": n_clusters,
            "batch_size": batch_size,
            "n_init": n_init,
            "labels": model.labels_.tolist(),
            "centers": model.cluster_centers_.tolist(),
            "n_steps": model.n_steps_,
        }

    def blobs(n, k, d, spread):
        centers = [[rng.randint(-50, 50) for _ in range(d)] for _ in range(k)]
        return [blob(centers[rng.randrange(k)], spread) for _ in range(n)]

    outliers = blobs(1500, 3, 4, 3) + [[300 + rng.randint(0, 2) for _ in range(4)] for _ in range(6)]
    kmeans_cases = [
        kmeans_case("6 blobs of 2000 samples", blobs(2000, 6, 4, 3), 6, 512, 1),
        kmeans_case("fewer samples than the init size, n_init auto", blobs(700, 5, 5, 2), 5, 500, "auto"),
        kmeans_case("noisy integers", [[rng.randint(0, 9) for _ in range(6)] for _ in range(1500)], 12, 512, 1),
        kmeans_case("4096 samples of 64 distinct points", [[rng.randint(0, 3) for _ in range(3)] for _ in range(4096)], 10, 512, 1),
        kmeans_case("a far cluster of 6 samples", outliers, 5, 512, 1),
        kmeans_case("fractions", [[rng.uniform(-1, 1) for _ in range(5)] for _ in range(600)], 4, 256, 1),
        kmeans_case("as many clusters as samples", [[float(i), float(i % 3)] for i in range(5)], 5, 512, 1),
    ]

    getcontext().prec = 60
    logs = np.log(np.arange(1, 16385, dtype=np.float64))
    misrounded = [
        {"x": x, "correctly_rounded": float(Decimal(x).ln())}
        for x in range(1, 16385)
        if math.log(x) != float(Decimal(x).ln())
    ]
    assert all(math.log(x) == float(logs[x - 1]) for x in range(1, 16385))

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, torch {VERSIONS['torch']}, "
    f"datasets {VERSIONS['datasets']}, scikit-learn {VERSIONS['scikit-learn']}, "
    f"scipy {VERSIONS['scipy']}, CPython {platform.python_version()}, {platform.system()} {platform.machine()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "code_point_dim": CODE_POINT_DIM,
            "tasks": tasks,
            "metric_cases": metric_cases,
            "kmeans_cases": kmeans_cases,
            "log": {
                "values": base64.b64encode(logs.astype("<f8").tobytes()).decode("ascii"),
                "misrounded": misrounded,
            },
        }
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(tasks)} tasks, {len(metric_cases)} metric cases, {len(kmeans_cases)} k-means cases, {len(misrounded)} misrounded logs", file=sys.stderr)
