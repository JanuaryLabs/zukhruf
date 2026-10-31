# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "bm25s==0.3.16", "PyStemmer==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of the BM25 languages in bm25.golden.test.ts with Python
# MTEB: uv run packages/mteb/src/models/model-implementations/fixtures/bm25-languages/generate.py
#
# It writes a folder dataset (README.md, corpus.jsonl, queries.jsonl,
# qrels/test.jsonl) for each language in a folder next to this file. Then it
# runs mteb/baseline-bm25s on each folder, with the language of the folder
# and the keyword arguments of each run, and writes expected.json: the
# experiment name, the model name with the experiment, the score of each
# document for each query and the main score of mteb.evaluate, for each run.
# It writes the scores of BM25Search with a function as the tokenizer, and
# what MTEB raises for such a function through load_model. It also writes,
# for each language of MTEB's _ISO3_TO_LANG and for a code that the table
# does not hold, the stopwords key of BM25Tokenizer, the stems of its
# stemmer for a list of probe words, the tokens of a probe corpus, and the
# tokens of probe queries after that corpus. Never
# edit expected.json by hand: run this script again.
#
# The texts are written for this fixture. They test the paths of
# BM25Tokenizer:
# - deu: the German stopwords and stemmer (the fast path), ß and umlauts,
#   and an explicit stopwords="en", which keeps the German stemmer.
# - fin: the Finnish stemmer and the stopwords from document frequencies
#   (the slow path). Each document holds a form of "talo" and 9 of 10 hold
#   "ihminen", so both stems are frequent. A query holds "talossa", an
#   inflected form of the frequent stem "talo", and the stem "ihmin" as a
#   word: MTEB removes a query word that equals a frequent stem before it
#   stems the words, so "ihmin", whose stem is "ihm", leaves the query, and
#   "talossa" stays with an idf of 0. One document holds "ihmin", so "ihm"
#   has a score. freq_threshold=0 takes the fast path without stopwords,
#   0.5 makes more stems frequent, and bm25+ gives the frequent stems, which
#   keep a vocabulary entry without documents, no non-occurrence score.
# - pol: a code that the table does not hold, so no stopwords and no
#   stemmer, and only the stopwords from document frequencies; an explicit
#   stemmer_language="polish" adds the Polish stemmer.
# - rus: the Russian stopwords and stemmer: Cyrillic, ё and Ё, and forms of
#   one word that differ in their final letters.
# - zho: the char tokenizer with the Chinese stopwords: each character is a
#   token, and "\n", which joins the title and the text, stays a token. An
#   explicit stopwords="zh" drops the char tokenizer, as in MTEB, so the
#   bm25s tokenizer splits the text.
# - jpn and tha: the char tokenizer with the stopwords from document
#   frequencies, so "\n" (in each document) leaves. freq_threshold=0 keeps
#   it. The texts hold characters that NFKC changes: full-width Latin
#   letters and digits, half-width katakana, the ligatures ﬁ and ﬀ, ①, ㎏,
#   ™ and ㍿, and a Greek word with a final sigma. 𩸽 (U+29E3D), a
#   character outside the Basic Multilingual Plane, is one token.
# - deu with a function as the tokenizer (text.split(" ") in Python and in
#   JavaScript): no lowercasing, no stemmer, and the stopwords from document
#   frequencies, or the German stopwords, which then leave only in lower
#   case.
import importlib.metadata
import importlib.util
import json
import os
import platform
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
README = (HERE.parent / "bm25" / "README.md").read_text(encoding="utf-8")

# Each folder: (eval_langs, corpus of (id, title, text), queries of (id, text, relevant documents)).
FOLDERS = {
    "deu": (
        ["deu-Latn"],
        [
            ("d01", "Das Haus", "Das alte Haus steht an der Straße, und die Häuser daneben sind neu."),
            ("d02", "", "Die Kinder spielen im Garten; ein Kind spielt nicht gern allein."),
            ("d03", "Straßen", "Große Straßen führen über den Fluss zur Stadt."),
            ("d04", "Bücher", "Er liest Bücher über Gärten, und sie las ein Buch über Häuser."),
            ("d05", "", "Der Fluss fließt durch die Stadt, die Flüsse fließen ins Meer."),
            ("d06", "Meer", "Am Meer ist es kalt; the sea and the wind are cold."),
            ("d07", "Garten", "Gärtnerinnen und Gärtner pflegen den Garten der Stadt."),
            ("d08", "", "und oder aber nicht doch"),
        ],
        [
            ("q01", "Häuser an der Straße", ["d01"]),
            ("q02", "spielende Kinder im Garten", ["d02", "d07"]),
            ("q03", "Bücher über Flüsse", ["d04", "d05"]),
            ("q04", "the sea and the cold wind", ["d06"]),
            ("q05", "und die der", ["d08"]),
            ("q06", "STRASSE straße Strasse", ["d01", "d03"]),
        ],
    ),
    "fin": (
        ["fin-Latn"],
        [
            ("d01", "Talo", "Ihminen asuu talossa järven rannalla."),
            ("d02", "", "Talon ihminen lukee kirjoja talvella metsässä."),
            ("d03", "Metsä", "Metsän talo on vanha, ja ihminen kävelee metsässä."),
            ("d04", "", "Taloon tulee ihminen ja koira kesällä."),
            ("d05", "Kirjat", "Ihminen kirjoittaa kirjan talosta ja metsästä."),
            ("d06", "", "Talot ovat järvellä, ja ihminen ui järvessä."),
            ("d07", "Kaupunki", "Kaupungin talo on suuri; ihminen asuu kaupungissa."),
            ("d08", "", "Taloja on paljon, ja ihminen laskee ne metsän reunalla."),
            ("d09", "Koira", "Koiran talo on pieni; ihminen antaa koiralle ruokaa."),
            ("d10", "Ihmin", "Talo ja ihmin: sana ihmin ei ole ihminen."),
        ],
        [
            ("q01", "ihminen asuu talossa", ["d01", "d07"]),
            ("q02", "ihmin metsässä", ["d10", "d03"]),
            ("q03", "talo", ["d04"]),
            ("q04", "kirjoja järvellä talvella", ["d02", "d06"]),
            ("q05", "koira kaupungissa", ["d07", "d09"]),
        ],
    ),
    "pol": (
        ["pol-Latn"],
        [
            ("d01", "Dom", "Dom jest duży, a ogród jest mały."),
            ("d02", "", "Kot jest w domu i śpi na łóżku."),
            ("d03", "Miasto", "Miasto jest stare; ulice są wąskie."),
            ("d04", "", "Rzeka jest długa i płynie przez miasto."),
            ("d05", "Książki", "Ta książka jest nowa, a książki są drogie."),
            ("d06", "", "Łódź jest na rzece, łodzie płyną szybko."),
            ("d07", "Ogród", "Ogrody są zielone, ogród jest piękny."),
            ("d08", "", "Żółty kwiat jest w ogrodzie obok domu."),
            ("d09", "Źródło", "Źródło rzeki jest w górach."),
            ("d10", "", "Pies biega po ulicy miasta."),
        ],
        [
            ("q01", "dom jest duży", ["d01"]),
            ("q02", "jest", ["d02"]),
            ("q03", "książki o mieście", ["d05", "d03"]),
            ("q04", "ŁÓDŹ na rzece", ["d06", "d04"]),
            ("q05", "ogród i kwiat", ["d07", "d08"]),
        ],
    ),
    "zho": (
        ["zho-Hans"],
        [
            ("d01", "中文", "我们的城市有很多河流和桥。"),
            ("d02", "", "他在图书馆里读书，她在家写字。"),
            ("d03", "河流", "这条河流过城市，河水很清。"),
            ("d04", "", "我们在公园里看见了一只猫和一只狗。"),
            ("d05", "图书", "图书馆的书很多，也有ＡＢＣ的书和①号书架。"),
            ("d06", "", "的了和是在"),
        ],
        [
            ("q01", "城市的河流", ["d01", "d03"]),
            ("q02", "图书馆里的书", ["d02", "d05"]),
            ("q03", "猫和狗", ["d04"]),
            ("q04", "的了是", ["d06"]),
            ("q05", "abc书架１", ["d05"]),
        ],
    ),
    "jpn": (
        ["jpn-Jpan"],
        [
            ("d01", "東京", "東京の川には多くの橋があります。"),
            ("d02", "", "私は図書館で本を読みます。ｶﾀｶﾅの本もあります。"),
            ("d03", "カタカナ", "カタカナとひらがなを学びます。𩸽は魚です。"),
            ("d04", "", "猫と犬が公園で遊んでいます。"),
            ("d05", "ＡＢＣ", "ＡＢＣの本は１２３ページです。"),
            ("d06", "", "ﬁleとoﬀiceの㎏と™と㍿。"),
            ("d07", "ΣΟΦΟΣ", "ギリシャ語のΣΟΦΟΣは賢いという意味です。"),
            ("d08", "", "の が は を に で"),
        ],
        [
            ("q01", "東京の橋", ["d01"]),
            ("q02", "カタカナの本と𩸽", ["d02", "d03"]),
            ("q03", "abc 123", ["d05"]),
            ("q04", "file office kg tm 株式会社", ["d06"]),
            ("q05", "σοφος", ["d07"]),
            ("q06", "猫と犬", ["d04"]),
        ],
    ),
    "tha": (
        ["tha-Thai"],
        [
            ("d01", "บ้าน", "บ้านหลังนี้อยู่ใกล้แม่น้ำ"),
            ("d02", "", "แมวนอนอยู่บนเตียงในบ้าน"),
            ("d03", "เมือง", "เมืองนี้มีถนนหลายสาย"),
            ("d04", "", "หนังสือเล่มนี้ใหม่มาก"),
            ("d05", "แม่น้ำ", "แม่น้ำไหลผ่านเมืองใหญ่ ๑๒๓"),
            ("d06", "", "ต้นไม้ในสวนสีเขียว"),
        ],
        [
            ("q01", "บ้านใกล้แม่น้ำ", ["d01", "d05"]),
            ("q02", "แมวในบ้าน", ["d02"]),
            ("q03", "ถนนในเมือง", ["d03"]),
            ("q04", "หนังสือ", ["d04"]),
        ],
    ),
    "rus": (
        ["rus-Cyrl"],
        [
            ("d01", "Книга", "Эта книга лежит на столе, и книги стоят на полке."),
            ("d02", "", "Он читает книгу, а она пишет книгой ёлку."),
            ("d03", "Ёлка", "Ёлки растут в лесу; ёлка зелёная."),
            ("d04", "", "Мы не знаем, что он читал в лесу."),
            ("d05", "Город", "Город большой, в городе много улиц и городов."),
            ("d06", "", "Улицы города узкие, а улица у реки широкая."),
            ("d07", "Река", "Река течёт через город, реки текут в море."),
            ("d08", "", "и в не что он на я с со"),
        ],
        [
            ("q01", "книги на столе", ["d01", "d02"]),
            ("q02", "ЁЛКИ в лесу", ["d03"]),
            ("q03", "улицы городов", ["d05", "d06"]),
            ("q04", "и не что", ["d08"]),
            ("q05", "речные реки", ["d07"]),
        ],
    ),
}

# (folder, keyword arguments of load_model)
RUNS = [
    ("deu", {}),
    ("deu", {"stopwords": "en"}),
    ("fin", {}),
    ("fin", {"freq_threshold": 0}),
    ("fin", {"freq_threshold": 0.5}),
    ("fin", {"method": "bm25+"}),
    ("pol", {}),
    ("pol", {"stemmer_language": "polish"}),
    ("rus", {}),
    ("zho", {}),
    ("zho", {"stopwords": "zh"}),
    ("jpn", {}),
    ("jpn", {"freq_threshold": 0}),
    ("tha", {}),
]

# (folder, keyword arguments of BM25Search besides the tokenizer): runs with
# the function text.split(" ") as the tokenizer.
FUNCTION_RUNS = [
    ("deu", {}),
    ("deu", {"stopwords": "de"}),
    ("deu", {"freq_threshold": 0.25}),
]

# Texts in many scripts, each with "\n": the tokens tell which tokenizer,
# stopwords and stemmer a language gets.
PROBE_CORPUS = [
    "The Häuser\n中文的文本 running talossa книгами",
    "ＡＢＣ ﬁsh\n日本語のテキスト the Häuser",
    "ไทย ข้อความ\nкнигами the 文本 𩸽",
]

# Queries for the tokenizer of each language after its fit on PROBE_CORPUS.
PROBE_QUERIES = ["The talo Häuser 文本 ＡＢＣ", "the\nкниги 𩸽 ไทย"]

# Words of many scripts: the stems tell which stemmer a language gets.
PROBE = [
    "running", "connections", "häuser", "gärten", "huizen", "maisons", "casas",
    "livros", "libri", "книгами", "husen", "husene", "talossa", "kirjoja",
    "كتابات", "գրքերը", "etxeetan", "cases", "husene", "domoj", "majades",
    "βιβλία", "किताबें", "házakban", "rumahnya", "leabhair", "namuose",
    "किताबहरू", "casele", "kućama", "புத்தகங்கள்", "evlerde", "ביכער",
]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


for folder, (_, corpus, queries) in FOLDERS.items():
    path = HERE / folder
    path.mkdir(exist_ok=True)
    (path / "README.md").write_text(README, encoding="utf-8")
    write_jsonl(path / "corpus.jsonl", [{"_id": doc, "title": title, "text": text} for doc, title, text in corpus])
    write_jsonl(path / "queries.jsonl", [{"_id": query, "text": text} for query, text, _ in queries])
    write_jsonl(
        path / "qrels" / "test.jsonl",
        [{"query-id": query, "corpus-id": doc, "score": 1} for query, _, docs in queries for doc in docs],
    )

# The datasets library keeps the Arrow files of a local dataset in its cache.
# A temporary cache leaves nothing behind.
with tempfile.TemporaryDirectory() as cache:
    os.environ["HF_DATASETS_CACHE"] = cache
    os.environ["HF_HUB_OFFLINE"] = "1"

    import mteb
    from mteb.abstasks.retrieval import AbsTaskRetrieval
    from mteb.abstasks.task_metadata import TaskMetadata
    from mteb.models.model_implementations.bm25 import _ISO3_TO_LANG, BM25Search, BM25Tokenizer, bm25_s

    def folder_task(folder: str):
        class FolderTask(AbsTaskRetrieval):
            metadata = TaskMetadata(
                name=f"Bm25Languages{folder.capitalize()}Fixture",
                description="The BM25 fixture of @zukhruf/mteb.",
                dataset={"path": str(HERE / folder), "revision": "1"},
                type="Retrieval",
                category="t2t",
                modalities=["text"],
                eval_splits=["test"],
                eval_langs=FOLDERS[folder][0],
                main_score="ndcg_at_10",
            )

        return FolderTask()

    # The quirk of the fin folder: q02 keeps "ihm" only when the query words
    # leave by their stem.
    fin_tokenizer = BM25Tokenizer("fin")
    fin_tokenizer.fit_transform(
        ["\n".join([title, text]) for _, title, text in FOLDERS["fin"][1]]
    )
    assert "ihmin" in fin_tokenizer._combined_stops and "talo" in fin_tokenizer._combined_stops
    assert fin_tokenizer.stemmer.stemWord("ihmin") == "ihm"

    def split_space(text: str) -> list[str]:
        return text.split(" ")

    function_runs = []
    for folder, kwargs in FUNCTION_RUNS:
        task = folder_task(folder)
        task.load_data()
        split = task.dataset["default"]["test"]
        location = {
            "task_metadata": task.metadata,
            "hf_split": "test",
            "hf_subset": "default",
            "encode_kwargs": {},
        }
        model = BM25Search(tokenizer=split_space, **kwargs)
        model.index(split["corpus"], **location)
        results = model.search(split["queries"], top_k=100, top_ranked=None, **location)
        function_runs.append(
            {
                "folder": folder,
                "kwargs": kwargs,
                "stopwords": sorted(model._tokenizer._combined_stops),
                "full": [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in results.items()],
            }
        )
    assert function_runs[2]["stopwords"], "freq_threshold 0.25 finds no frequent token"

    # A function through load_model: the experiment name raises.
    loaded = bm25_s.load_model(tokenizer=split_space)
    try:
        loaded.mteb_model_meta.experiment_name
        raise AssertionError("experiment_name did not raise")
    except ValueError as error:
        load_model_error = str(error)

    runs = []
    for folder, kwargs in RUNS:
        task = folder_task(folder)
        task.load_data()
        split = task.dataset["default"]["test"]
        location = {
            "task_metadata": task.metadata,
            "hf_split": "test",
            "hf_subset": "default",
            "encode_kwargs": {},
        }
        model = bm25_s.load_model(**kwargs)
        model.index(split["corpus"], **location)
        results = model.search(split["queries"], top_k=100, top_ranked=None, **location)
        result = mteb.evaluate(bm25_s.load_model(**kwargs), task, cache=None)
        runs.append(
            {
                "folder": folder,
                "kwargs": kwargs,
                "experiment_name": model.mteb_model_meta.experiment_name,
                "model_name_with_experiment": model.mteb_model_meta.model_name_with_experiment,
                "full": [[query, [[doc, score] for doc, score in docs.items()]] for query, docs in results.items()],
                "main_score": result.task_results[0].scores["test"][0]["main_score"],
            }
        )

    languages = []
    for code in [*_ISO3_TO_LANG, "pol"]:
        tokenizer = BM25Tokenizer(code)
        encoded = tokenizer.fit_transform(PROBE_CORPUS)
        id_to_token = {token_id: token for token, token_id in encoded.vocab.items()}

        def decode(tokenized):
            names = {token_id: token for token, token_id in tokenized.vocab.items()}
            return [[names[token_id] for token_id in ids] for ids in tokenized.ids]

        languages.append(
            {
                "language": code,
                "stopwords_key": tokenizer.stopwords_key,
                "stems": None if tokenizer.stemmer is None else tokenizer.stemmer.stemWords(PROBE),
                "tokens": [[id_to_token[token_id] for token_id in ids] for ids in encoded.ids],
                "query_tokens": decode(tokenizer.transform(PROBE_QUERIES)),
            }
        )

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, bm25s {VERSIONS['bm25s']}, "
    f"PyStemmer {VERSIONS['PyStemmer']}, numpy {VERSIONS['numpy']}, "
    f"datasets {VERSIONS['datasets']}, CPython {platform.python_version()}"
)
# One run or language on each line keeps the file small.
(HERE / "expected.json").write_text(
    f'{{"generator": {json.dumps(generator)}, "probe": {json.dumps(PROBE, ensure_ascii=False)}, '
    + f'"probe_corpus": {json.dumps(PROBE_CORPUS, ensure_ascii=False)}, '
    + f'"probe_queries": {json.dumps(PROBE_QUERIES, ensure_ascii=False)}, '
    + f'"load_model_error": {json.dumps(load_model_error)}, "languages": [\n'
    + ",\n".join(json.dumps(language, ensure_ascii=False) for language in languages)
    + '\n], "runs": [\n'
    + ",\n".join(json.dumps(run, ensure_ascii=False) for run in runs)
    + '\n], "function_runs": [\n'
    + ",\n".join(json.dumps(run, ensure_ascii=False) for run in function_runs)
    + "\n]}\n",
    encoding="utf-8",
)
print(f"{generator}: {len(runs)} runs, {len(function_runs)} function runs, {len(languages)} languages", file=sys.stderr)
