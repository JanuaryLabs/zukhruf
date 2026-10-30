# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the BM25 fixture of bm25.golden.test.ts and bm25.test.ts with Python
# MTEB: uv run packages/mteb/src/models/model-implementations/fixtures/bm25/generate.py
#
# It writes the folder dataset (README.md, corpus.jsonl, queries.jsonl,
# qrels/test.jsonl) next to this file, runs MTEB's mteb/baseline-bm25s on it,
# and writes expected.json: the score of each document for each query, a
# reranking, the main score of mteb.evaluate and the stem of each word.
# Never edit expected.json by hand: run this script again.
#
# The texts test the tokenizer and the stemmer: an empty title, an empty
# document, a document of stopwords only, repeated query words, a query of
# unknown words, a query of stopwords only, words that stem to one stem,
# digits, "_" and one-letter words, İ, ß, ï, the ligature ﬁ, the Greek final
# sigma, a letter outside the Basic Multilingual Plane, a query with an
# instruction, and words whose stems Snowball 3.0.0 or 3.1.0 changed (NEWS:
# -ogist, undoubling, emerge, evening, lateral, organ, past, universe, -eed and
# -ing, skis, inter-), so that a stemmer of another version fails the test.
import importlib.metadata
import importlib.util
import json
import os
import platform
import re
import sys
import tempfile
from pathlib import Path

# bm25s picks jax for the top-k and numba for the scores when they are
# installed. MTEB's numbers here come from its numpy path.
for module in ("jax", "numba"):
    assert importlib.util.find_spec(module) is None, f"{module} must not be installed"

VERSIONS = {
    "mteb": "2.26.28",
    "bm25s": "0.3.16",
    "PyStemmer": "3.1.0",
    "numpy": "2.5.4",
    "datasets": "5.1.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

HERE = Path(__file__).resolve().parent

CORPUS = [
    ("d01", "Connection basics", "A connection connects two connected systems; connections fail."),
    ("d02", "", "The cat sat on the mat. Cats like mats."),
    ("d03", "", "It is not that they will be there or then."),
    ("d04", "Geology", "A geologist studies geology and geological layers."),
    ("d05", "Doubles", "Add an egg, then off we go: added eggs, offing."),
    ("d06", "Emergency", "The emergency team emerged; emergencies emerge at evening, even evenings."),
    ("d07", "Anatomy", "Lateral organs: organic organization, later the organ organizes."),
    ("d08", "Paste", "Past the paste, pasted pasting."),
    ("d09", "Universe", "The universe, universal truths and the university."),
    ("d10", "Skiing", "Skis, ski, skies and the sky; skiing skied."),
    ("d11", "Internals", "Intern, internal, international, internment."),
    ("d12", "Interference", "Interfere, interferes, interference, interfered, interfering; the interval."),
    ("d13", "Vying", "Vying and hying, dying, lying, tying; agreed, proceed, exceed."),
    ("d14", "Numbers", "COVID_19 reached 42 cases in 2020; x y z a1 b_ _ 7z"),
    ("d15", "İstanbul", "İstanbul and ISTANBUL by the Bosphorus."),
    ("d16", "Straße", "Die Straße and STRASSE are streets."),
    ("d17", "Naïve", "A naïve naive approach; naïvely."),
    ("d18", "Ligature", "The ﬁnance ﬁle ﬁnal; finance file final."),
    ("d19", "Greek", "ΟΔΟΣ ΟΔΟΣ ΣΟΦΟΣ and σοφός."),
    ("d20", "Deseret", "The word 𐐀bout has one letter outside the plane; runs."),
    ("d21", "Running", "Running runners run; the runner ran."),
    ("d22", "Retrieval", "Lexical retrieval ranks documents by BM25 scores."),
    ("d23", "Embeddings", "Dense embeddings encode documents as vectors."),
    ("d24", "Repeated", "search search search engine engine"),
    (
        "d25",
        "Long document",
        "Search engines index documents, tokenize text, stem words, remove stopwords and "
        "score each document against each query with BM25, a ranking function based on "
        "term frequency and inverse document frequency.",
    ),
    ("d26", "Short", "BM25"),
    ("d27", "Only a title here", ""),
    ("d28", "", ""),
    ("d29", "Mixed CASE", "HELLO hello HeLLo World"),
    ("d30", "Apostrophes", "The dog's bone, the dogs' bones, don't won't."),
    ("d31", "Ranking words", "Rank words, score words, rank documents."),
    ("d32", "A query", "Each query has words; each word has a score in each document of the search."),
    ("d33", "Scores", "score scores scored scoring"),
    ("d34", "Documents and queries", "Documents answer queries. A query finds documents, and documents hold words."),
    ("d35", "Search engine notes", "The engine ranks the corpus. The engine scores each document for each query, then it sorts the scores and keeps the best documents of the search."),
    ("d36", "Text", "text"),
    ("d37", "Words of a text", "A text has words and each word has a stem: the stem of running is run, the stem of documents is document."),
    ("d38", "Frequency", "Term frequency counts a word in a document; document frequency counts the documents that hold the word; frequency matters."),
    ("d39", "Retrieval engine", "A retrieval engine searches documents with queries and ranks them by score."),
    (
        "d40",
        "A long text about search",
        "Search is old. Library catalogs searched cards, and early engines searched words in documents. "
        "Each engine kept a list of documents for each word, and each query read the lists of its words. "
        "Then the engine scored each document and ranked the documents by score. BM25 is one such score: "
        "it counts each word of the query in the document, weights rare words more, and divides by the length "
        "of the document, so that a long document does not win only by its length.",
    ),
]

# (id, text, instruction or None, relevant documents)
QUERIES = [
    ("q01", "connection connected", None, ["d01"]),
    ("q02", "geology geologist", None, ["d04"]),
    ("q03", "search search engine", None, ["d24", "d25"]),
    ("q04", "zzzz qqqq xyzzy", None, ["d26"]),
    ("q05", "İstanbul Straße naïve", None, ["d15", "d16", "d17"]),
    ("q06", "ﬁnance final", None, ["d18"]),
    ("q07", "σοφός ΟΔΟΣ", None, ["d19"]),
    ("q08", "skis interval interference", None, ["d10", "d12"]),
    ("q09", "the of and", None, ["d03"]),
    ("q10", "BM25 ranking documents", "Find lexical retrieval documents", ["d22", "d25"]),
    ("q11", "emergency evening universe", None, ["d06", "d09"]),
    ("q12", "running COVID_19 42", None, ["d14", "d21"]),
    ("q13", "𐐀bout deseret", None, ["d20"]),
    ("q14", "organ organic later lateral", None, ["d07"]),
    ("q15", "add egg off", None, ["d05"]),
    ("q16", "document word score", None, ["d32", "d33"]),
    ("q17", "search engine ranks documents by score", None, ["d35", "d39", "d40"]),
    ("q18", "query words text stem", None, ["d37", "d34"]),
    ("q19", "frequency of a word in documents", None, ["d38"]),
    ("q20", "rank documents rank words scores", None, ["d31", "d33"]),
]

# The candidates of the reranking: each query ranks only these.
TOP_RANKED = {
    "q01": ["d01", "d21", "d03"],
    "q03": ["d24", "d25", "d02"],
    "q04": ["d01", "d02"],
}

# More words whose stems Snowball 3.0.0 or 3.1.0 changed.
EXTRA_WORDS = [
    "geologist", "geologists", "geology", "add", "egg", "off", "ebb", "emerge",
    "emergency", "evening", "even", "lateral", "later", "organ", "organic",
    "organize", "past", "paste", "universe", "universal", "university", "skis",
    "ski", "skies", "intern", "internal", "international", "internment",
    "interfere", "interferes", "interference", "interfered", "interfering",
    "interval", "vying", "hying", "agreed", "proceed", "exceed", "succeed",
    "generously", "communism", "arsenal",
]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


(HERE / "README.md").write_text(
    """---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
---
""",
    encoding="utf-8",
)
write_jsonl(
    HERE / "corpus.jsonl",
    [{"_id": doc, "title": title, "text": text} for doc, title, text in CORPUS],
)
write_jsonl(
    HERE / "queries.jsonl",
    [
        {"_id": query, "text": text, **({} if instruction is None else {"instruction": instruction})}
        for query, text, instruction, _ in QUERIES
    ],
)
write_jsonl(
    HERE / "qrels" / "test.jsonl",
    [
        {"query-id": query, "corpus-id": doc, "score": 1}
        for query, _, _, docs in QUERIES
        for doc in docs
    ],
)

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    import Stemmer
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.model_implementations.bm25 import bm25_s

    class Bm25Fixture(AbsTaskRetrieval):
        metadata = TaskMetadata(
            name="Bm25Fixture",
            description="The BM25 fixture of @zukhruf/mteb.",
            dataset={"path": str(HERE), "revision": "1"},
            type="Retrieval",
            category="t2t",
            modalities=["text"],
            eval_splits=["test"],
            eval_langs=["eng-Latn"],
            main_score="ndcg_at_10",
        )

    task = Bm25Fixture()
    task.load_data()
    split = task.dataset["default"]["test"]
    location = {
        "task_metadata": task.metadata,
        "hf_split": "test",
        "hf_subset": "default",
        "encode_kwargs": {},
    }

    def run(top_ranked):
        model = bm25_s.load_model()
        model.index(split["corpus"], **location)
        results = model.search(split["queries"], top_k=100, top_ranked=top_ranked, **location)
        return [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in results.items()]

    full = run(None)
    rerank = run(TOP_RANKED)

    result = mteb.evaluate(bm25_s.load_model(), task, cache=None)
    main_score = result.task_results[0].scores["test"][0]["main_score"]

    # The words of the texts, as bm25s splits them before it stems them.
    texts = [f"{title}\n{text}" for _, title, text in CORPUS] + [
        text if instruction is None else f"{text} {instruction}"
        for _, text, instruction, _ in QUERIES
    ]
    words = sorted(
        {word for text in texts for word in re.findall(r"(?u)\b\w\w+\b", text.lower())}
        | set(EXTRA_WORDS)
    )
    stems = Stemmer.Stemmer("english").stemWords(words)

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, bm25s {VERSIONS['bm25s']}, "
    f"PyStemmer {VERSIONS['PyStemmer']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "top_ranked": TOP_RANKED,
            "full": full,
            "rerank": rerank,
            "main_score": main_score,
            "stems": [[word, stem] for word, stem in zip(words, stems, strict=True)],
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{generator}: {sum(len(docs) for _, docs in full)} scores, {len(stems)} stems", file=sys.stderr)
