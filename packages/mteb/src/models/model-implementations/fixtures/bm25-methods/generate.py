# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of the bm25s methods in bm25.golden.test.ts with Python
# MTEB: uv run packages/mteb/src/models/model-implementations/fixtures/bm25-methods/generate.py
#
# It writes a folder dataset (README.md, corpus.jsonl, queries.jsonl,
# qrels/test.jsonl) next to this file. Then it runs mteb/baseline-bm25s with
# each bm25s method (robertson, lucene, atire, bm25l and bm25+), once with the
# default settings and once with k1 1.2, b 0.5 and delta 0.3, on this folder
# and on the folder of the BM25 fixture (../bm25). It writes expected.json:
# the score of each document for each query and the main score of
# mteb.evaluate, for each run. Never edit expected.json by hand: run this
# script again.
#
# Each document of this folder has "common", so its idf is 0 for atire and,
# after the clip of the inner value to 1, for robertson. "often" is in more
# than half of the documents, so robertson clips it too. A document repeats
# a word 31 times. Some queries have 12 known tokens or more, so numpy adds
# their non-occurrence scores (bm25l, bm25+) pairwise, not in order; the
# script checks that this changes a sum. Other queries have repeated
# tokens, unknown tokens only, or stopwords only.
import importlib.metadata
import importlib.util
import json
import os
import platform
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
BM25_FOLDER = HERE.parent / "bm25"

METHODS = ["robertson", "lucene", "atire", "bm25l", "bm25+"]
SETTINGS = [{}, {"k1": 1.2, "b": 0.5, "delta": 0.3}]

WORDS = [
    "apple", "banana", "cherry", "grape", "lemon", "mango", "melon", "olive",
    "peach", "pear", "plum", "quince", "berry", "date", "fig", "kiwi",
]

CORPUS = [
    (
        f"d{index:02d}",
        "" if index % 4 else f"Note {WORDS[index % 16]}",
        " ".join(
            ["common"]
            + (["often"] if index % 3 else [])
            + [WORDS[index % 16]] * (index % 5 + 1)
            + [WORDS[(index * 7 + 3) % 16]]
            + (WORDS[: index % 9] if index % 2 else [])
        ),
    )
    for index in range(30)
]
CORPUS.append(("d30", "", "common often " + "kiwi " * 31))
CORPUS.append(("d31", "Common", "common"))

# (id, text, relevant documents)
QUERIES = [
    ("q01", "common", ["d31"]),
    ("q02", "often common banana", ["d01"]),
    ("q03", "apple banana cherry grape lemon mango melon olive peach pear plum quince", ["d02", "d03"]),
    ("q04", "kiwi kiwi berry date fig kiwi apple apple cherry cherry plum pear often mango", ["d30"]),
    ("q05", "zzzz qqqq xyzzy", ["d04"]),
    ("q06", "the of and", ["d05"]),
    ("q07", "kiwi", ["d30", "d15"]),
    ("q08", "lemon unknownword melon zzzz", ["d04", "d06"]),
    ("q09", "berry date fig kiwi apple banana cherry grape lemon mango melon olive peach common often", ["d12"]),
]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


(HERE / "README.md").write_text((BM25_FOLDER / "README.md").read_text(encoding="utf-8"), encoding="utf-8")
write_jsonl(
    HERE / "corpus.jsonl",
    [{"_id": doc, "title": title, "text": text} for doc, title, text in CORPUS],
)
write_jsonl(HERE / "queries.jsonl", [{"_id": query, "text": text} for query, text, _ in QUERIES])
write_jsonl(
    HERE / "qrels" / "test.jsonl",
    [{"query-id": query, "corpus-id": doc, "score": 1} for query, _, docs in QUERIES for doc in docs],
)

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import numpy as np
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.model_implementations.bm25 import bm25_s

    def folder_task(name: str, path: Path):
        class FolderTask(AbsTaskRetrieval):
            metadata = TaskMetadata(
                name=name,
                description="The BM25 fixture of @zukhruf/mteb.",
                dataset={"path": str(path), "revision": "1"},
                type="Retrieval",
                category="t2t",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=["eng-Latn"],
                main_score="ndcg_at_10",
            )

        return FolderTask()

    pairwise_differs = False
    runs = []
    for folder, task_name, path in [
        ("methods", "Bm25MethodsFixture", HERE),
        ("bm25", "Bm25Fixture", BM25_FOLDER),
    ]:
        task = folder_task(task_name, path)
        task.load_data()
        split = task.dataset["default"]["test"]
        location = {
            "task_metadata": task.metadata,
            "hf_split": "test",
            "hf_subset": "default",
            "encode_kwargs": {},
        }
        for method in METHODS:
            for settings in SETTINGS:
                kwargs = {"method": method, **settings}
                model = bm25_s.load_model(**kwargs)
                model.index(split["corpus"], **location)
                results = model.search(split["queries"], top_k=100, top_ranked=None, **location)
                if model.retriever.nonoccurrence_array is not None:
                    queries = model._tokenizer.transform([row["text"] for row in split["queries"]])
                    tokens = {token_id: token for token, token_id in queries.vocab.items()}
                    for query in queries.ids:
                        known = model.retriever.get_tokens_ids([tokens[token_id] for token_id in query])
                        values = model.retriever.nonoccurrence_array[np.asarray(known, dtype=np.int32)]
                        in_order = np.float32(0)
                        for value in values:
                            in_order = np.float32(in_order + value)
                        if in_order != values.sum():
                            pairwise_differs = True
                result = mteb.evaluate(bm25_s.load_model(**kwargs), task, cache=None)
                runs.append(
                    {
                        "folder": folder,
                        "kwargs": kwargs,
                        "full": [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in results.items()],
                        "main_score": result.task_results[0].scores["test"][0]["main_score"],
                    }
                )
    assert pairwise_differs, "no query sum depends on numpy's pairwise order"

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, bm25s {VERSIONS['bm25s']}, "
    f"PyStemmer {VERSIONS['PyStemmer']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
# One run on each line keeps the file small.
(HERE / "expected.json").write_text(
    f'{{"generator": {json.dumps(generator)}, "runs": [\n'
    + ",\n".join(json.dumps(run, ensure_ascii=False) for run in runs)
    + "\n]}\n",
    encoding="utf-8",
)
print(f"{generator}: {len(runs)} runs", file=sys.stderr)
