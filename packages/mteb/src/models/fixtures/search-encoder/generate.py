# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of search-encoder.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/models/fixtures/search-encoder/generate.py
#
# It writes expected.json: a corpus, the queries, and the results that
# SearchEncoderWrapper of MTEB gives when it searches the corpus in chunks
# with a top_k smaller than the corpus. Never edit expected.json by hand: run
# this script again.
#
# The text of each document and query is its vector: "3 5" is [3, 5]. The
# model scores with the dot product, thus each score is a small integer and no
# order of a BLAS sum can change a bit. In each chunk the scores of one query
# are all different, because torch.topk does not fix the order of equal
# scores. Across the chunks the scores repeat, so the heap keeps a document or
# drops it at the cut by its id.
import importlib.metadata
import json
import os
import platform
import random
import sys
import tempfile
from pathlib import Path

VERSIONS = {"mteb": "2.26.28", "numpy": "2.5.4", "torch": "2.14.1", "datasets": "5.1.0"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent
CHUNK_SIZE = 5
TOP_KS = [3, 4, 7]
N_DOCUMENTS = 24

rng = random.Random(3418)
documents = []
for start in range(0, N_DOCUMENTS, CHUNK_SIZE):
    size = min(CHUNK_SIZE, N_DOCUMENTS - start)
    xs = rng.sample(range(1, 11), size)
    ys = rng.sample(range(1, 11), size)
    for offset, (x, y) in enumerate(zip(xs, ys, strict=True)):
        documents.append({"id": f"d{start + offset}", "text": f"{x} {y}"})
queries = [{"id": "q1", "text": "1 0"}, {"id": "q2", "text": "0 1"}]

# The datasets library keeps its files in a cache. A temporary cache leaves
# nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import numpy as np
    from datasets import Dataset
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.abs_encoder import AbsEncoder
    from mteb.models.model_meta import ModelMeta, ScoringFunction
    from mteb.models.search_wrappers import SearchEncoderWrapper

    class Coordinates(AbsEncoder):
        mteb_model_meta = ModelMeta.create_empty(
            overwrites={"name": "test/coordinates", "revision": "1", "similarity_fn_name": ScoringFunction.DOT_PRODUCT}
        )

        def __init__(self) -> None:
            pass

        def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
            return np.array(
                [[float(value) for value in text.split()] for batch in inputs for text in batch["text"]],
                dtype=np.float32,
            )

    metadata = TaskMetadata(
        name="SearchEncoderFixture",
        description="The search encoder fixture of @zukhruf/mteb.",
        dataset={"path": "none", "revision": "1"},
        type="Retrieval",
        category="t2t",
        modalities=["text"],
        eval_splits=["test"],
        eval_langs=["eng-Latn"],
        main_score="ndcg_at_10",
    )
    location = {"task_metadata": metadata, "hf_split": "test", "hf_subset": "default", "encode_kwargs": {}}

    searches = []
    for top_k in TOP_KS:
        model = SearchEncoderWrapper(Coordinates(), corpus_chunk_size=CHUNK_SIZE)
        model.index(Dataset.from_list(documents), **location)
        results = model.search(Dataset.from_list(queries), top_k=top_k, top_ranked=None, **location)
        searches.append(
            {
                "top_k": top_k,
                "results": [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in results.items()],
            }
        )

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, numpy {VERSIONS['numpy']}, torch {VERSIONS['torch']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "corpus_chunk_size": CHUNK_SIZE,
            "corpus": documents,
            "queries": queries,
            "searches": searches,
        },
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(searches)} searches", file=sys.stderr)
