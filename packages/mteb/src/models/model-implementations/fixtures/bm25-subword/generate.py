# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0", "tokenizers==0.23.3", "transformers==5.22.1", "huggingface_hub==2.4.0"]
# ///
# Makes the fixture of bm25-subword.network.spec.ts and bm25.golden.test.ts
# with Python MTEB:
# uv run packages/mteb/src/models/model-implementations/fixtures/bm25-subword/generate.py
#
# It downloads tokenizer.json of Qwen/Qwen3-0.6B at "main", as
# Tokenizer.from_pretrained does, into a temporary cache, and requires the
# commit and the sha256 below. Then it writes expected.json: ModelMeta.to_dict
# of mteb/baseline-bm25s-subword, the tokens and ids of each text of TEXTS,
# the tokens that MTEB's subword tokenizer keeps, and, for each run of
# mteb/baseline-bm25s-subword on a folder dataset of the BM25 fixtures, the
# experiment name, the score of each document for each query and the main
# score of mteb.evaluate.
#
# It also writes tiny-tokenizer.json, a small BPE tokenizer whose tokens hold
# " " and "▁", and the tokens, the kept tokens and the scores of BM25Search
# with it on a small corpus. MTEB reads it from the cache of the Hub in
# offline mode, so the test can serve it from a stand-in for the Hub. Never
# edit expected.json or tiny-tokenizer.json by hand: run this script again.
#
# The texts test the regex of the Split pre-tokenizer of Qwen3 and the BPE:
# the contractions in upper case ((?i:'s|...)), runs of digits (\p{N} takes
# one digit), "\r\n" and runs of spaces before a word (\s+(?!\S)), U+0085
# and U+180E (\s in Oniguruma, other rules in JavaScript), U+FEFF, U+3000,
# U+00A0, scripts without spaces (CJK, Thai, Khmer), Arabic, Devanagari,
# Cyrillic, emoji with a ZWJ and a skin tone, a character outside the BMP,
# NFC (the normalizer) on a decomposed é, and the text of special tokens.
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import sys
import tempfile
from pathlib import Path

for module in ("jax", "numba"):
    assert importlib.util.find_spec(module) is None, f"{module} must not be installed"

VERSIONS = {
    "mteb": "2.26.28",
    "bm25s": "0.3.16",
    "PyStemmer": "3.1.0",
    "numpy": "2.5.4",
    "datasets": "5.1.0",
    "tokenizers": "0.23.3",
    "transformers": "5.22.1",
    "huggingface_hub": "2.4.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

REPOSITORY = "Qwen/Qwen3-0.6B"
COMMIT = "c1899de289a04d12100db370d81485cdf75e47ca"
SHA256 = "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent

TEXTS = [
    "The quick brown fox jumps over the lazy dog.",
    "IT'S HE'LL WE'VE THEY'RE I'M YOU'D DON'T it's he'll",
    "1234567890 3.14159 1,000,000 ٣٤٥ ①②",
    "line one\r\nline two\n\n\nline three\r\r",
    "    four spaces before\t\ttabs   and three after   ",
    "next\u0085line mongolian᠎vowel bom﻿here ideographic　space no break",
    "我们的城市有很多河流和桥。東京の川には多くの橋があります。",
    "บ้านหลังนี้อยู่ใกล้แม่น้ำ ភាសាខ្មែរ",
    "مرحبا بالعالم नमस्ते दुनिया Привет, мир!",
    "👩‍👩‍👧‍👦 family 👍🏽 thumbs 𩸽 fish 𐐀bout",
    "Café café ﬁle ＡＢＣ",
    "<|im_start|>user\nhello<|im_end|> <|endoftext|>",
    "",
    "▁ underscore-like ▁▁ and Ġ and Ċ",
]

TINY_REPOSITORY = "zukhruf/tiny-tokenizer"
TINY_COMMIT = "0123456789abcdef0123456789abcdef01234567"
TINY_TOKENIZER = {
    "version": "1.0",
    "truncation": None,
    "padding": None,
    "added_tokens": [],
    "normalizer": None,
    "pre_tokenizer": {"type": "Split", "pattern": {"Regex": "[ ▁]?[^ ▁\\n]+|[ ▁\\n]"}, "behavior": "Removed", "invert": True},
    "post_processor": None,
    "decoder": None,
    "model": {
        "type": "BPE",
        "dropout": None,
        "unk_token": None,
        "continuing_subword_prefix": None,
        "end_of_word_suffix": None,
        "fuse_unk": False,
        "byte_fallback": False,
        "ignore_merges": False,
        "vocab": {"a": 0, "b": 1, "c": 2, "d": 3, " ": 4, "▁": 5, "\n": 6, " a": 7, " b": 8, "▁a": 9, "▁b": 10},
        "merges": [[" ", "a"], [" ", "b"], ["▁", "a"], ["▁", "b"]],
    },
}
TINY_TEXTS = ["a b\n▁a ▁ c", "  ▁▁ d", ""]
# (id, title, text): "\n" joins the title and the text, so it is in each
# document and leaves as a stopword from document frequencies.
TINY_CORPUS = [
    ("d1", "", "a b"),
    ("d2", "", "b ▁a"),
    ("d3", "c", "▁b c d"),
    ("d4", "", " a ▁ d d"),
    ("d5", "", "c c c"),
]
TINY_QUERIES = [("q1", "b a"), ("q2", "▁ c"), ("q3", "▁d"), ("q4", " ▁ ")]

# (folder, eval_langs, keyword arguments of load_model)
RUNS = [
    ("bm25", ["eng-Latn"], {}),
    ("bm25", ["eng-Latn"], {"stopwords": "en"}),
    ("bm25", ["eng-Latn"], {"freq_threshold": 0}),
    ("bm25-languages/jpn", ["jpn-Jpan"], {}),
]

with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_HOME"] = cache
    os.environ["HF_DATASETS_CACHE"] = os.path.join(cache, "datasets")

    import mteb
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.model_implementations.bm25 import BM25Search, bm25_s_subword
    from tokenizers import Tokenizer

    hf_tok = Tokenizer.from_pretrained(REPOSITORY)
    storage = Path(cache) / "hub" / f"models--{REPOSITORY.replace('/', '--')}"
    assert (storage / "refs" / "main").read_text() == COMMIT, (storage / "refs" / "main").read_text()
    downloaded = (storage / "snapshots" / COMMIT / "tokenizer.json").read_bytes()
    assert hashlib.sha256(downloaded).hexdigest() == SHA256

    subword = BM25Search(tokenizer=REPOSITORY)._tokenizer_cfg
    texts = []
    for text in TEXTS:
        encoding = hf_tok.encode(text, add_special_tokens=False)
        texts.append({"text": text, "tokens": encoding.tokens, "ids": encoding.ids, "kept": subword(text)})

    def folder_task(folder: str, eval_langs: list[str]):
        class FolderTask(AbsTaskRetrieval):
            metadata = TaskMetadata(
                name="Bm25SubwordFixture",
                description="The BM25 fixture of @zukhruf/mteb.",
                dataset={"path": str(FIXTURES / folder), "revision": "1"},
                type="Retrieval",
                category="t2t",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=eval_langs,
                main_score="ndcg_at_10",
            )

        return FolderTask()

    model_meta = bm25_s_subword.to_dict()

    runs = []
    for folder, eval_langs, kwargs in RUNS:
        task = folder_task(folder, eval_langs)
        task.load_data()
        split = task.dataset["default"]["test"]
        location = {
            "task_metadata": task.metadata,
            "hf_split": "test",
            "hf_subset": "default",
            "encode_kwargs": {},
        }
        model = bm25_s_subword.load_model(**kwargs)
        model.index(split["corpus"], **location)
        results = model.search(split["queries"], top_k=100, top_ranked=None, **location)
        result = mteb.evaluate(bm25_s_subword.load_model(**kwargs), task, cache=None)
        runs.append(
            {
                "folder": folder,
                "eval_langs": eval_langs,
                "kwargs": kwargs,
                "experiment_name": model.mteb_model_meta.experiment_name,
                "full": [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in results.items()],
                "main_score": result.task_results[0].scores["test"][0]["main_score"],
            }
        )

    # The tiny tokenizer: its tokens hold " " and "▁", which MTEB's subword
    # tokenizer removes, so that a token of only those characters leaves.
    # MTEB reads it from the cache of the Hub in offline mode, as
    # Tokenizer.from_pretrained reads any tokenizer.json at "main".
    tiny = Tokenizer.from_str(json.dumps(TINY_TOKENIZER))
    (HERE / "tiny-tokenizer.json").write_text(tiny.to_str(), encoding="utf-8")
    tiny_storage = Path(cache) / "hub" / f"models--{TINY_REPOSITORY.replace('/', '--')}"
    (tiny_storage / "refs").mkdir(parents=True)
    (tiny_storage / "refs" / "main").write_text(TINY_COMMIT)
    (tiny_storage / "snapshots" / TINY_COMMIT).mkdir(parents=True)
    (tiny_storage / "snapshots" / TINY_COMMIT / "tokenizer.json").write_text(tiny.to_str(), encoding="utf-8")
    import huggingface_hub.constants

    huggingface_hub.constants.HF_HUB_OFFLINE = True
    tiny_model = BM25Search(tokenizer=TINY_REPOSITORY)
    huggingface_hub.constants.HF_HUB_OFFLINE = False
    tiny_texts = [
        {"text": text, "tokens": tiny.encode(text, add_special_tokens=False).tokens, "kept": tiny_model._tokenizer_cfg(text)}
        for text in TINY_TEXTS
    ]
    tiny_model.index(
        [{"id": doc, "title": title, "text": text} for doc, title, text in TINY_CORPUS],
        task_metadata=None,
        hf_split="test",
        hf_subset="default",
        encode_kwargs={},
    )
    from datasets import Dataset

    tiny_results = tiny_model.search(
        Dataset.from_list([{"id": query, "text": text} for query, text in TINY_QUERIES]),
        task_metadata=None,
        hf_split="test",
        hf_subset="default",
        top_k=100,
        encode_kwargs={},
    )
    assert "\n" in tiny_model._tokenizer._combined_stops
    tiny_run = {
        "corpus": TINY_CORPUS,
        "queries": TINY_QUERIES,
        "stopwords": sorted(tiny_model._tokenizer._combined_stops),
        "full": [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in tiny_results.items()],
    }

generator = "generate.py: " + ", ".join(f"{name} {version}" for name, version in VERSIONS.items()) + f", CPython {platform.python_version()}"
# One text or run on each line keeps the file small.
(HERE / "expected.json").write_text(
    f'{{"generator": {json.dumps(generator)}, "repository": {json.dumps(REPOSITORY)}, '
    + f'"commit": {json.dumps(COMMIT)}, "sha256": {json.dumps(SHA256)}, '
    + f'"model_meta": {json.dumps(model_meta, ensure_ascii=False)}, "texts": [\n'
    + ",\n".join(json.dumps(text, ensure_ascii=False) for text in texts)
    + '\n], "runs": [\n'
    + ",\n".join(json.dumps(run, ensure_ascii=False) for run in runs)
    + f'\n], "tiny_repository": {json.dumps(TINY_REPOSITORY)}, "tiny_texts": [\n'
    + ",\n".join(json.dumps(text, ensure_ascii=False) for text in tiny_texts)
    + f'\n], "tiny_run": {json.dumps(tiny_run, ensure_ascii=False)}}}\n',
    encoding="utf-8",
)
print(f"{generator}: {len(texts)} texts, {len(runs)} runs", file=sys.stderr)
