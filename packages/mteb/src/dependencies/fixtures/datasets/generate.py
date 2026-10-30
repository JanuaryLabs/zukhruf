# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "datasets==5.1.0", "pyarrow==26.0.0", "numpy==2.5.4", "torch==2.14.1"]
# ///
# Makes the dataset folders and the golden rows of datasets.test.ts with the
# HuggingFace datasets library:
# uv run packages/mteb/src/dependencies/fixtures/datasets/generate.py
#
# It writes one folder for each layout that load_dataset reads (the configs of
# a dataset card, files named for their split, a folder for each split, sharded
# parquet files, the subsets of a multilingual dataset, the features of a card)
# and expected.json: for each folder and config name, the splits that
# load_dataset gives, with the column names and the rows of each split.
# Never edit expected.json or the folders by hand: run this script again.
import gzip
import importlib.metadata
import json
import os
import platform
import shutil
import tempfile
from pathlib import Path

VERSIONS = {
    "mteb": "2.26.28",
    "datasets": "5.1.0",
    "pyarrow": "26.0.0",
    "numpy": "2.5.4",
    "torch": "2.14.1",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

os.environ["HF_DATASETS_OFFLINE"] = "1"

import datasets  # noqa: E402
import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

HERE = Path(__file__).resolve().parent


def jsonl(rows):
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)


def write(folder, files):
    for path, content in files.items():
        target = HERE / folder / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, pa.Table):
            pq.write_table(content, target)
        elif isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")


def gz(text):
    # mtime=0 keeps the bytes of the file the same at each run.
    return gzip.compress(text.encode("utf-8"), mtime=0)


# The parquet types that datasets reads: strings, integers, floats, booleans,
# lists, structs and nulls.
TYPED = pa.table(
    {
        "sentence": ["s0", None, "s2"],
        "count": pa.array([1, 2**40, None], type=pa.int64()),
        "small": pa.array([1, -2, 3], type=pa.int32()),
        "score": pa.array([0.1, 0.5, None], type=pa.float32()),
        "wide": pa.array([0.1, 1e300, -0.0], type=pa.float64()),
        "flag": [True, False, None],
        "tags": [["a", "b"], [], None],
        "ids": pa.array([[1, 2], [None], []], type=pa.list_(pa.int64())),
        "meta": [{"k": "x", "v": 1}, {"k": None, "v": 2}, None],
    }
)

CASES = {
    # The configs of a dataset card name the files of each split. The second
    # config has a data_dir and no data_files: load_dataset infers its files
    # inside that folder.
    "card-configs": {
        "files": {
            "README.md": """---
configs:
- config_name: default
  data_files:
  - split: test
    path: pairs/test.jsonl
  - split: train
    path:
    - pairs/train-b.jsonl
    - pairs/train-a.json
- config_name: extra
  data_dir: extra
---
# A dataset with configs
""",
            "pairs/test.jsonl": jsonl(
                [
                    {"sentence1": "Ada", "sentence2": "Ben", "label": 1},
                    {"sentence2": "Cy", "sentence1": "Dee", "label": 0.5, "note": "ünï"},
                    {"sentence1": "Eve", "label": None},
                ]
            ),
            "pairs/train-b.jsonl": jsonl(
                [{"label": 1, "sentence1": "b", "sentence2": "x"}, {"sentence1": "c", "label": 2.5}]
            ),
            "pairs/train-a.json": json.dumps(
                [{"note": "n", "sentence2": "y", "sentence1": "a", "label": 0.1}, {"sentence1": "d"}]
            ),
            "extra/test.jsonl": jsonl([{"x": [1, 2]}, {"x": []}]),
            "extra/train.jsonl": jsonl([{"x": [3]}]),
        },
        "names": [None, "extra"],
    },
    # No configs: the split keyword in each file name names its split.
    "split-in-filename": {
        "files": {
            "README.md": "# No configs here\n",
            "train.jsonl.gz": gz(
                jsonl(
                    [
                        {"labels": [0], "sentence1": ["t1"], "sentence2": ["u1"]},
                        {"sentence1": ["t2", "t3"], "sentence2": ["u2", "u3"], "labels": [1, 1]},
                    ]
                )
            ),
            "test.json.gz": gz(
                json.dumps(
                    [{"sentence1": ["q1", "q2"], "sentence2": ["d1", "d2"], "labels": [1, 0]}]
                )
            ),
            "more_test_2.jsonl": jsonl([{"sentence1": ["q3"], "sentence2": ["d3"], "labels": [1]}]),
            ".hidden/test.jsonl": jsonl([{"sentence1": ["hidden"], "sentence2": ["x"], "labels": [0]}]),
            "notes.yaml": "not: data\n",
        },
        "names": [None],
    },
    # No configs: a folder for each split, with the keywords of each split.
    "split-in-dir": {
        "files": {
            "validation/part-0.jsonl": jsonl([{"text": "v0"}]),
            "dev/part-1.jsonl": jsonl([{"text": "v1"}]),
            "test/b.jsonl": jsonl([{"text": "t-b"}]),
            "test/a.jsonl": jsonl([{"text": "t-a"}]),
            "__pycache__/test/c.jsonl": jsonl([{"text": "special"}]),
        },
        "names": [None],
    },
    # No configs: sharded parquet files in data/, as push_to_hub writes them.
    # The second train shard has its columns in another order; the splits
    # take the columns of the first file of the train split.
    "sharded": {
        "files": {
            "data/train-00000-of-00002.parquet": TYPED,
            "data/train-00001-of-00002.parquet": TYPED.select(TYPED.column_names[::-1]).slice(1),
            "data/test-00000-of-00001.parquet": TYPED.slice(0, 2),
            "data/custom-00000-of-00001.parquet": TYPED.slice(2),
        },
        "names": [None],
    },
    # The subsets of a multilingual task: one config for each language, with
    # parquet files that datasets writes.
    "multilingual": {
        "files": {
            "README.md": """---
configs:
- config_name: en
  data_files:
  - split: test
    path: en/test.parquet
  - split: train
    path: en/train.parquet
- config_name: de
  data_files:
  - split: test
    path: de/test-*.parquet
---
""",
        },
        "datasets": {
            "en/test.parquet": {"sentence1": ["hello"], "sentence2": ["hi"], "score": [4.5]},
            "en/train.parquet": {"sentence1": ["a"], "sentence2": ["b"], "score": [1.0]},
            "de/test-1.parquet": {"sentence1": ["hallo"], "sentence2": ["moin"], "score": [3.0]},
            "de/test-0.parquet": {"sentence1": ["tag"], "sentence2": ["servus"], "score": [2.0]},
        },
        "names": ["en", "de"],
    },
    # The features of the dataset card: their order and their types.
    "card-features": {
        "files": {
            "README.md": """---
dataset_info:
  features:
  - name: score
    dtype: float32
  - name: text
    dtype: string
  - name: label
    dtype:
      class_label:
        names:
          '0': neg
          '1': pos
  - name: values
    sequence: float32
  - name: count
    dtype: int32
  - name: missing
    dtype: string
---
""",
            "train.jsonl": jsonl(
                [
                    {"text": "a", "score": "0.1", "label": 1, "values": [0.1, 2], "count": "7"},
                    {"text": "b", "score": 2, "label": 0, "values": None, "count": "-3"},
                ]
            ),
        },
        "names": [None],
    },
    # No configs and no split keyword: every data file is in the train split.
    "all": {
        "files": {
            "foo.jsonl": jsonl([{"a": 1}]),
            "bar/baz.jsonl": jsonl([{"a": 2}]),
            "README.md": "# All files\n",
        },
        "names": [None],
    },
}

expected = {}
for folder, case in CASES.items():
    shutil.rmtree(HERE / folder, ignore_errors=True)
    write(folder, case["files"])
    for path, columns in case.get("datasets", {}).items():
        target = HERE / folder / path
        target.parent.mkdir(parents=True, exist_ok=True)
        datasets.Dataset.from_dict(columns).to_parquet(target)
    loads = []
    for name in case["names"]:
        dataset_dict = datasets.load_dataset(str(HERE / folder), name=name, cache_dir=tempfile.mkdtemp())
        loads.append(
            {
                "name": name,
                "splits": [
                    {
                        "split": split,
                        "columns": dataset.column_names,
                        "rows": dataset.to_list(),
                    }
                    for split, dataset in dataset_dict.items()
                ],
            }
        )
    expected[folder] = loads

(HERE / "expected.json").write_text(
    json.dumps(expected, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8"
)
