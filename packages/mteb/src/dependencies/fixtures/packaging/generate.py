# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "packaging==26.3", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of packaging.golden.test.ts with packaging and MTEB:
# uv run packages/mteb/src/dependencies/fixtures/packaging/generate.py
#
# expected.json holds:
# - versions: str(Version(text)) for each text, or the message of the
#   InvalidVersion that Version(text) raises;
# - sorted: the texts that are versions, sorted by Version (a stable sort);
# - ranges: the top-level mteb_version that
#   TaskResult._compute_top_level_mteb_version of MTEB gives for subsets with
#   these versions.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

VERSIONS = {"mteb": "2.26.28", "packaging": "26.3"}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

from mteb.results.task_result import TaskResult
from packaging.version import InvalidVersion, Version

TEXTS = [
    # pre, post and dev releases, and their other spellings
    "2.10.0.dev3", "2.10.0a1", "2.10.0alpha2", "2.10.0b1", "2.10.0beta", "2.10.0c1", "2.10.0pre2",
    "2.10.0preview3", "2.10.0rc1", "2.10.0", "2.10.0.post1", "2.10.0-2", "2.10.0rev3", "2.10.0r",
    "2.10.0.post1.dev2", "2.10.0a1.post1", "2.10.0a1.dev1", "2.10.0-RC_1", "2.10", "2.10.0.0",
    # epochs
    "1!1.0", "0!2.0", "2!0.1",
    # local versions
    "2.10.0+cu121", "2.10.0+cu118", "2.10.0+abc.5", "2.10.0+ABC-01_x", "2.10.0+5", "2.10.0+abc",
    "1.0+01", "1.0+000", "1.0+18446744073709551617", "1.0+18446744073709551616",
    # padded input and a v prefix
    " 1.2.3 ", "\t2.0\n", "v1.0", "V2.0rc1",
    # numbers above 2 ** 53
    "1.18446744073709551617", "1.18446744073709551616", "9007199254740993", "9007199254740992",
    "18446744073709551617!1.0", "1.0rc18446744073709551617", "1.0.post18446744073709551617",
    "1.0.dev18446744073709551617",
    # invalid input
    "nope", "", "1.0+", "1.0+abc..1", "2.10.0 rc1", "1.0-", "v", "1.0.x",
]

versions = []
for text in TEXTS:
    try:
        versions.append({"text": text, "normal": str(Version(text))})
    except InvalidVersion as error:
        versions.append({"text": text, "error": str(error)})

valid = [entry["text"] for entry in versions if "normal" in entry]
RANGES = [
    ["2.10.0", "2.10.0+cu121"],
    ["2.10.0+cu121", "2.10.0+cu118"],
    ["2.10.0+abc", "2.10.0+5"],
    ["1!1.0", "2.0"],
    ["2.10.0rc1", "2.10.0.post1.dev2"],
    ["1.0+01", "1.0+2"],
]
ranges = [
    {
        "versions": pair,
        "mteb_version": TaskResult._compute_top_level_mteb_version(
            {"test": [{"hf_subset": f"s{index}", "mteb_version": version} for index, version in enumerate(pair)]}
        ),
    }
    for pair in RANGES
]

generator = f"generate.py: mteb {VERSIONS['mteb']}, packaging {VERSIONS['packaging']}, CPython {platform.python_version()}"
(Path(__file__).resolve().parent / "expected.json").write_text(
    json.dumps(
        {"generator": generator, "versions": versions, "sorted": sorted(valid, key=Version), "ranges": ranges},
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(versions)} texts, {len(ranges)} ranges", file=sys.stderr)
