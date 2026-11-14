# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4", "safetensors==0.8.0"]
# ///
# Makes the fixtures of load-weights.test.ts with safetensors 0.8.0, the
# library that Venn's runtime.load_weights calls:
# uv run --no-project packages/vector-decisions/src/safetensors/fixtures/generate.py
#
# - golden.safetensors: float32 tensors of shape [0, 3], [], [5], [5], [3, 4]
#   and [2, 3, 2], with -0, +-infinity, NaN, the smallest subnormal and the
#   float32 maximum among the values, and a __metadata__ entry. The empty
#   tensor "blank" has the byte range [0, 0], so it starts at the same byte
#   as the next tensor.
# - int32.safetensors: one float32 tensor and one int32 tensor. An int32
#   value has 4 bytes, as a float32 value has, so only its type tells it apart.
# - expected.json: for each tensor of golden.safetensors, as
#   safetensors.numpy.load_file reads it back, its shape and the bits of each
#   value as 8 hexadecimal digits (JSON has no NaN or infinity); the length
#   of the header; and the metadata.
# Never edit these files by hand: run this script again.
import importlib.metadata
import json
import platform
from pathlib import Path

VERSIONS = {"numpy": "2.5.4", "safetensors": "0.8.0"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import numpy as np
from safetensors.numpy import load_file, save_file

HERE = Path(__file__).resolve().parent
METADATA = {"format": "np", "source": "generate.py"}

rng = np.random.default_rng(20261114)
float32 = np.finfo(np.float32)
tensors = {
    "blank": np.zeros((0, 3), dtype=np.float32),
    "temperature": np.array(0.06702037537345655, dtype=np.float32),
    "signs": np.array([0.0, -0.0, 1.0, np.inf, -np.inf], dtype=np.float32),
    "edges": np.array([np.nan, float32.smallest_subnormal, float32.max, -float32.max, 1 / 3], dtype=np.float32),
    "matrix": rng.standard_normal((3, 4)).astype(np.float32),
    "cube": rng.standard_normal((2, 3, 2)).astype(np.float32),
}
save_file(tensors, HERE / "golden.safetensors", metadata=METADATA)
save_file(
    {"weight": np.ones((2, 2), dtype=np.float32), "count": np.arange(3, dtype=np.int32)},
    HERE / "int32.safetensors",
)

loaded = load_file(HERE / "golden.safetensors")
data = (HERE / "golden.safetensors").read_bytes()
expected = {
    "headerLength": int.from_bytes(data[:8], "little"),
    "metadata": METADATA,
    "tensors": {
        name: {
            "shape": list(value.shape),
            "bits": [f"{bits:08x}" for bits in value.astype("<f4").reshape(-1).view("<u4").tolist()],
        }
        for name, value in sorted(loaded.items())
    },
}
(HERE / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
