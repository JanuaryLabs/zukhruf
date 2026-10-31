# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the embedding cache fixture of cache-wrapper.golden.test.ts with
# Python MTEB:
# uv run packages/mteb/src/models/cache-wrappers/fixtures/numpy-cache/generate.py
#
# It sends six encode calls through CachedEmbeddingWrapper with NumpyCache
# (initial_vectors=4, so vectors.npy doubles twice) and writes the cache
# folder to python-cache/. The calls have no title and no instruction, so
# the second preparation of MTEB on a cache miss gives the same texts. Then
# it encodes titled documents and instructed queries into defect-cache/,
# where the second preparation doubles the title and the instruction.
# expected.json holds, for each call, the texts that the model got and the
# embeddings that the wrapper returned.
# Never edit expected.json or the cache folders by hand: run this script again.
#
# The encoder gives each text t the float32 vector
# [cp(t) / 7, len(t) / 3, (cp(t) % 13) / 11, 1 / (1 + len(t))], where cp(t)
# is the sum of the code points of t and len(t) the number of code points.
import functools
import importlib.metadata
import json
import platform
import shutil
from pathlib import Path

import numpy as np
from datasets import Dataset

import mteb
from mteb._create_dataloaders import create_dataloader
from mteb.models.cache_wrappers import CachedEmbeddingWrapper
from mteb.models.cache_wrappers.cache_backends import NumpyCache
from mteb.models.model_meta import ModelMeta
from mteb.types import PromptType

VERSIONS = {"mteb": "2.26.28", "numpy": "2.5.4", "datasets": "5.1.0", "torch": "2.14.1"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent
TASK = mteb.get_task("SCIDOCS").metadata


def vector(text: str) -> list[float]:
    cp = sum(ord(char) for char in text)
    return [cp / 7, len(text) / 3, (cp % 13) / 11, 1 / (1 + len(text))]


class RecordingEncoder:
    def __init__(self) -> None:
        self.mteb_model_meta = ModelMeta.create_empty({"name": "test/recording", "revision": "1"})
        self.texts: list[str] = []

    def encode(self, inputs, *, task_metadata, hf_split, hf_subset, prompt_type=None, **kwargs):
        texts = [text for batch in inputs for text in batch["text"]]
        self.texts.extend(texts)
        return np.array([vector(text) for text in texts], dtype=np.float32)

    def similarity(self, embeddings1, embeddings2):
        raise NotImplementedError

    def similarity_pairwise(self, embeddings1, embeddings2):
        raise NotImplementedError


def run(folder: Path, calls: list[dict]) -> list[dict]:
    shutil.rmtree(folder, ignore_errors=True)
    encoder = RecordingEncoder()
    wrapper = CachedEmbeddingWrapper(
        encoder, folder, cache_backend=functools.partial(NumpyCache, initial_vectors=4)
    )
    results = []
    for call in calls:
        prompt_type = PromptType(call["prompt_type"]) if call["prompt_type"] else None
        inputs = create_dataloader(
            Dataset.from_list(call["rows"]), task_metadata=TASK, prompt_type=prompt_type
        )
        start = len(encoder.texts)
        embeddings = wrapper.encode(
            inputs,
            task_metadata=TASK,
            hf_split="test",
            hf_subset="default",
            prompt_type=prompt_type,
            **call["kwargs"],
        )
        assert embeddings.dtype == np.float32, embeddings.dtype
        results.append(
            {
                **call,
                "model_texts": encoder.texts[start:],
                "embeddings": embeddings.tolist(),
            }
        )
    wrapper.close()
    return results


def texts(*values: str) -> list[dict]:
    return [{"text": value} for value in values]


CALLS = [
    {"case": "no prompt type", "prompt_type": None, "rows": texts("alpha", "beta", "gamma"), "kwargs": {}},
    {"case": "queries without instructions", "prompt_type": "query", "rows": [{"id": "q1", "text": "delta"}, {"id": "q2", "text": "alpha"}], "kwargs": {}},
    {"case": "documents without titles", "prompt_type": "document", "rows": [{"id": "d1", "text": "alpha"}, {"id": "d2", "text": "  padded  "}], "kwargs": {}},
    {"case": "a text twice in one call", "prompt_type": None, "rows": texts("epsilon", "zeta", "epsilon", "eta", "theta"), "kwargs": {}},
    {"case": "hits and misses", "prompt_type": None, "rows": texts("beta", "iota", "alpha", "kappa"), "kwargs": {}},
    {"case": "precision int8", "prompt_type": None, "rows": texts("alpha", "lambda"), "kwargs": {"precision": "int8"}},
]

DEFECT_CALLS = [
    {"case": "titled documents", "prompt_type": "document", "rows": [{"id": "d1", "title": "T", "text": "one"}, {"id": "d2", "title": "Short", "text": "two"}], "kwargs": {}},
    {"case": "instructed queries", "prompt_type": "query", "rows": [{"id": "q1", "text": "alpha", "instruction": "find"}, {"id": "q2", "text": "beta", "instruction": "rank"}], "kwargs": {}},
]

expected = {
    "task": TASK.name,
    "initial_vectors": 4,
    "calls": run(HERE / "python-cache", CALLS),
    "defect_calls": run(HERE / "defect-cache", DEFECT_CALLS),
}
(HERE / "expected.json").write_text(json.dumps(expected, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
