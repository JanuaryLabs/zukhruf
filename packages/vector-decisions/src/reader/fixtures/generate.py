# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "venn-vdm @ git+https://github.com/markrussinovich/venn-vdm@7b2042e84608fbdd143ac21dea7c83d5ae2ec723",
#   "torch==2.15.0",
#   "numpy==2.5.4",
# ]
# ///
# Makes the fixture of the vector cache tests with Venn's own steps, at the
# commit that the package ports:
# uv run --no-project packages/vector-decisions/src/reader/fixtures/generate.py
#
# expected.json holds texts, the raw vectors of a reader for them, of
# several lengths, and the vectors that Venn's own DecisionService.embed gives
# for the texts with that reader: venn.reader.unit normalizes in float64, the
# cache stores float16 (venn/server.py:270-277), and embed divides each
# float32 copy by its norm (venn/server.py:163). "vectors" is the first call
# (the misses), and the script checks that a second call (the hits) gives
# the same vectors. The vectors are numbers, as JSON writes float32 values
# exactly. Besides 9 random rows of 3 scales, the raw vectors hold a zero
# vector, a row of norm about 3e-8, and two rows that the script finds for
# which a normalization in float32 gives other float16 values than Venn's in
# float64. "prompts" holds the task prompts of the reader at Venn's pinned
# revision, from its config_sentence_transformers.json.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import os
import platform
import tempfile
from pathlib import Path

VERSIONS = {"venn-vdm": "0.1.0", "torch": "2.15.0", "numpy": "2.5.4"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()
os.environ["VENN_HOME"] = tempfile.mkdtemp(prefix="venn-home-")

import numpy as np

from huggingface_hub import hf_hub_download

from venn.cli import download_head
from venn.reader import MODEL_ID, PROMPTS, REVISION
from venn.server import DecisionService

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(20261114)
def float16_differs(row):
    in_float64 = (row / np.linalg.norm(row)).astype(np.float16)
    row32 = row.astype(np.float32)
    in_float32 = (row32 / np.float32(np.linalg.norm(row32))).astype(np.float16)
    return not np.array_equal(in_float64, in_float32)


ties = []
while len(ties) < 2:
    candidate = rng.standard_normal(768)
    if float16_differs(candidate):
        ties.append(candidate)
raw = np.concatenate([
    *[rng.standard_normal((3, 768)) * scale for scale in (1e-3, 1.0, 40.0)],
    np.zeros((1, 768)),
    rng.standard_normal((1, 768)) * 1e-9,
    np.stack(ties),
])
texts = [f"text {index}" for index in range(len(raw))]
row_of = {text: row for text, row in zip(texts, raw)}
state = Path(tempfile.mkdtemp(prefix="venn-state-"))
service = DecisionService(
    embed=lambda batch: np.array([row_of[text] for text in batch]),
    cache_path=state / "cache.sqlite",
    registry_path=state / "calibrations.json",
    model_dir=download_head(),
)
misses = service.embed(texts)
hits = service.embed(texts)
assert service.embed_count == len(texts)
assert np.array_equal(misses, hits)
prompts = json.loads(Path(hf_hub_download(MODEL_ID, "config_sentence_transformers.json", revision=REVISION)).read_text())["prompts"]
(HERE / "expected.json").write_text(json.dumps({
    "prompts": {name: prompts[name] for name in PROMPTS},
    "texts": texts,
    "raw": raw.tolist(),
    "vectors": misses.tolist(),
}) + "\n")
