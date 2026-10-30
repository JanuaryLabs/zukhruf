# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the loader names fixture of model-implementations.test.ts with Python
# MTEB: uv run packages/mteb/src/models/model-implementations/fixtures/loader-names/generate.py
#
# It writes expected.json: for each model that this package ports, the loader
# name that MTEB writes in model_meta.json (_get_loader_name of the loader of
# its ModelMeta). MTEB finds the loader in its registry by this name when it
# reads the file.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
from pathlib import Path

VERSIONS = {
    "mteb": "2.26.28",
    "bm25s": "0.3.16",
    "PyStemmer": "3.1.0",
    "numpy": "2.5.4",
    "torch": "2.14.1",
    "datasets": "5.1.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import mteb  # noqa: E402
from mteb.models.model_meta import _get_loader_name  # noqa: E402

MODELS = [
    "Qwen/Qwen3-Embedding-0.6B",
    "Qwen/Qwen3-Embedding-4B",
    "Qwen/Qwen3-Embedding-8B",
    "google/embeddinggemma-2",
    "mteb/baseline-bm25s",
]

expected = {name: _get_loader_name(mteb.get_model_meta(name).loader) for name in MODELS}
(Path(__file__).resolve().parent / "expected.json").write_text(
    json.dumps(expected, indent=2) + "\n", encoding="utf-8"
)
