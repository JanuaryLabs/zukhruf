# /// script
# requires-python = "==3.12.9"
# dependencies = ["jsonschema==4.26.0"]
# ///
# Makes the fixture of sob.golden.test.ts with SOB's evaluate.py at commit
# da785a8521c8954283b2989d01e54d80c4e023c6 of https://github.com/interfazeai/sob:
# uv run packages/structured-eval/src/paths/fixtures/sob-evaluate/generate.py
#
# responses.jsonl holds hand-written SOB response lines, one for each edge
# path of the port: int against float, a float repr, NaN, integer-like keys,
# a null, a text and a scalar candidate, an invalid schema, unknown
# complexities, missing required keys, wrong types, arrays paired by index,
# extra paths, True == 1, articles and punctuation, Unicode case, an empty
# expected record, a null leaf, a format that Draft7Validator does not
# assert, keywords of later drafts that Draft 7 ignores, a repeated key, a
# $ref, True == 1 without a type, floats against their repr text (1e15 is
# fixed, 1e16 is not), the article
# an, the underscore in a word, schema_complexity before difficulty, two
# empty texts, an int at a number, null against the text null, key order, a
# required path inside an array, a path F1 just below the gate, sums where
# CPython's compensated sum differs from a plain one, a malformed line and a
# blank line, then the meta-schema lines (backlog #3806): a $ref to the
# draft-07 meta-schema, with and without its empty fragment, a schema whose
# own $id is that URI, an empty and a repeated enum, a pattern that is not a
# regular expression, a $schema, an $id and a $ref that are not URIs, and a
# regex format that Draft7Validator does not assert.
#
# expected.json holds the eval_records rows of evaluate.py for the lines it
# scores, and the summary of build_summary (1000 bootstrap samples, seed 42).
# Never edit expected.json by hand: run this script again.
import hashlib
import importlib.util
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

COMMIT = "da785a8521c8954283b2989d01e54d80c4e023c6"
URL = f"https://raw.githubusercontent.com/interfazeai/sob/{COMMIT}/evaluate.py"
SHA256 = "e38e727490c5409dc4d457fa6f6bd3097209cdf5689851fcd33a6fbbd8fd382d"

assert sys.version.startswith("3.12.9"), sys.version

here = Path(__file__).parent
source = urllib.request.urlopen(URL, timeout=30).read()
assert hashlib.sha256(source).hexdigest() == SHA256, "evaluate.py changed"

with tempfile.TemporaryDirectory() as folder:
    module_path = Path(folder) / "evaluate.py"
    module_path.write_bytes(source)
    spec = importlib.util.spec_from_file_location("evaluate", module_path)
    evaluate = importlib.util.module_from_spec(spec)
    # A dataclass with string annotations looks its module up in sys.modules.
    sys.modules["evaluate"] = evaluate
    spec.loader.exec_module(evaluate)

    responses = here / "responses.jsonl"
    records, data_quality = evaluate.evaluate_file(responses, "text")
    summary = evaluate.build_summary(
        response_file=responses,
        records=records,
        data_quality=data_quality,
        bootstrap_samples=1000,
        seed=42,
        top_k_errors=20,
        modality="text",
    )

expected = {
    "generator": f"generate.py: evaluate.py {COMMIT[:7]}, CPython {sys.version.split()[0]}, jsonschema 4.26.0",
    "records": [record.row for record in records],
    "data_quality": data_quality,
    "summary": summary["summary"],
}
(here / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
print(f"{len(records)} records, data quality {data_quality}")
