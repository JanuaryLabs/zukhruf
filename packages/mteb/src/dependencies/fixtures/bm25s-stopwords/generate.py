# /// script
# requires-python = "==3.12.9"
# dependencies = ["bm25s==0.3.16"]
# ///
# Makes the fixture of bm25s-stopwords.golden.test.ts with bm25s 0.3.16:
# uv run packages/mteb/src/dependencies/fixtures/bm25s-stopwords/generate.py
#
# It writes expected.json: the 11 stopword lists of bm25s/stopwords.py that
# MTEB's _get_stopwords maps, by MTEB's key, in the order of the file.
# Never edit expected.json by hand: run this script again.
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

assert importlib.metadata.version("bm25s") == "0.3.16", importlib.metadata.version("bm25s")
assert platform.python_version() == "3.12.9", platform.python_version()

from bm25s import stopwords  # noqa: E402

HERE = Path(__file__).resolve().parent

# The keys and lists of _get_stopwords in mteb/models/model_implementations/bm25.py.
LISTS = {
    "en": stopwords.STOPWORDS_EN,
    "de": stopwords.STOPWORDS_GERMAN,
    "nl": stopwords.STOPWORDS_DUTCH,
    "fr": stopwords.STOPWORDS_FRENCH,
    "es": stopwords.STOPWORDS_SPANISH,
    "pt": stopwords.STOPWORDS_PORTUGUESE,
    "it": stopwords.STOPWORDS_ITALIAN,
    "ru": stopwords.STOPWORDS_RUSSIAN,
    "sv": stopwords.STOPWORDS_SWEDISH,
    "no": stopwords.STOPWORDS_NORWEGIAN,
    "zh": stopwords.STOPWORDS_CHINESE,
}

generator = f"generate.py: bm25s {importlib.metadata.version('bm25s')}, CPython {platform.python_version()}"
# One list on each line keeps the file small.
(HERE / "expected.json").write_text(
    f'{{"generator": {json.dumps(generator)}, "lists": {{\n'
    + ",\n".join(f"{json.dumps(key)}: {json.dumps(list(words), ensure_ascii=False)}" for key, words in LISTS.items())
    + "\n}}\n",
    encoding="utf-8",
)
print(f"{generator}: {sum(len(words) for words in LISTS.values())} words", file=sys.stderr)
