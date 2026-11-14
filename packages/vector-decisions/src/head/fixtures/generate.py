# /// script
# requires-python = "==3.12.9"
# dependencies = [
#   "venn-vdm @ git+https://github.com/markrussinovich/venn-vdm@7b2042e84608fbdd143ac21dea7c83d5ae2ec723",
#   "torch==2.15.0",
#   "numpy==2.5.4",
#   "safetensors==0.8.0",
#   "huggingface-hub==2.4.0",
# ]
# ///
# Makes the fixtures of the head tests with Venn's own classes, at the commit
# that the package ports:
# uv run --no-project packages/vector-decisions/src/head/fixtures/generate.py
#
# - tiny-head.safetensors: a CosineAbstention of Venn with 8 numbers for each
#   vector and 4 hidden units. Each parameter is drawn at random, so its
#   "none" network is not zero as a new head's is. Its buffers are fixed:
#   temperature 0.1, and none_intercept 0.3 / 0.1.
# - tiny-head.json: for questions with 2, 3 and 5 options, the question, the
#   options, unit states (float32 values) and the logits that
#   venn.index.apply.PreparedQuestion gives for them in float64: the head and
#   the vectors become float64 first, so the logits carry no rounding error
#   of float32, and a port that computes in float64 can match them to 1e-12.
#   Each case has a name. Besides the cases of 2, 3 and 5 options: one option,
#   and two equal options with the same vector as the question, whose
#   centered vectors are zero, which F.normalize keeps at zero; options of
#   length 1e-20, whose centered norms are below the 1e-12 that F.normalize
#   divides by at least; and no option, for which prewarm divides by 1.
# - venn-1.json: the same for the venn-1 head (768 numbers for each vector),
#   which this script downloads at its pinned revision. A test with network
#   access compares the package with it.
# Never edit these files by hand: run this script again.
import importlib.metadata
import json
import os
import platform
import tempfile
from pathlib import Path

VERSIONS = {"venn-vdm": "0.1.0", "torch": "2.15.0", "numpy": "2.5.4", "safetensors": "0.8.0", "huggingface-hub": "2.4.0"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()
os.environ["VENN_HOME"] = tempfile.mkdtemp(prefix="venn-home-")

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file, save_file
from torch.nn import functional as F

from venn.heads.abstention import CosineAbstention
from venn.index.apply import PreparedQuestion
from venn.profiles import HEAD_REPO_ID, HEAD_REVISION

HERE = Path(__file__).resolve().parent
torch.manual_seed(20261114)
rng = np.random.default_rng(20261114)


def unit(rows):
    return F.normalize(torch.tensor(rng.standard_normal(rows), dtype=torch.float32), dim=-1)


def case(name, head, dimensions, options, states, question=None, option_vectors=None):
    question = unit((1, dimensions))[0] if question is None else question
    option_vectors = unit((options, dimensions)) if option_vectors is None else option_vectors
    state_vectors = unit((states, dimensions))
    logits = PreparedQuestion(head.double(), question.double(), option_vectors.double()).logits(
        state_vectors.double()
    )
    return {
        "name": name,
        "question": question.tolist(),
        "options": option_vectors.tolist(),
        "states": state_vectors.tolist(),
        "logits": logits.tolist(),
    }


tiny = CosineAbstention(0.1, 0.3, dimensions=8, hidden=4)
for parameter in tiny.parameters():
    torch.nn.init.normal_(parameter, std=0.5)
save_file(tiny.state_dict(), HERE / "tiny-head.safetensors")
same = unit((1, 8))[0]
cases = [case(f"{options} options", tiny, 8, options, 4) for options in (2, 3, 5)]
cases.append(case("1 option", tiny, 8, 1, 4))
cases.append(case("equal options", tiny, 8, 2, 4, question=same, option_vectors=torch.stack([same, same])))
cases.append(case("tiny options", tiny, 8, 2, 4, option_vectors=unit((2, 8)) * 1e-20))
cases.append(case("no option", tiny, 8, 0, 4, option_vectors=torch.empty((0, 8))))
(HERE / "tiny-head.json").write_text(json.dumps({"cases": cases}, indent=2) + "\n")

config = json.loads(Path(hf_hub_download(HEAD_REPO_ID, "assets/config.json", revision=HEAD_REVISION)).read_text())
venn_1 = CosineAbstention(config["baseline"]["temperature"], config["baseline"]["none_logit"])
venn_1.load_state_dict(load_file(hf_hub_download(HEAD_REPO_ID, "assets/universal.safetensors", revision=HEAD_REVISION)))
venn_1.eval()
(HERE / "venn-1.json").write_text(json.dumps({"cases": [case("3 options", venn_1, 768, 3, 4)]}) + "\n")
