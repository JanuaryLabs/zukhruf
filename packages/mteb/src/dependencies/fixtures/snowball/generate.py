# /// script
# requires-python = "==3.12.9"
# dependencies = ["PyStemmer==3.1.0"]
# ///
# Makes the fixture of pystemmer.golden.test.ts with PyStemmer 3.1.0, which
# binds the C stemmers of libstemmer_c 3.1.0:
# uv run packages/mteb/src/dependencies/fixtures/snowball/generate.py
#
# It writes expected.json: the stem of each word of a word list for each of
# the 36 algorithms, a probe list and the sha256 of its stems for each name
# and alias of an algorithm, and the error of names that PyStemmer refuses.
# Never edit expected.json by hand: run this script again.
#
# The words of an algorithm come from two sources:
# - Words made from the string literals of its JavaScript stemmer in
#   ../../snowball/ (the suffixes and other strings of the algorithm): each
#   literal alone and after two other literals, the second word with a
#   letter outside the Basic Multilingual Plane at code point 1 to 4, the
#   literal after another literal and such a letter, and for each second
#   literal a word with two different such letters, and for the first four
#   literals a word with U+E000 and such a letter. The C stemmers count UTF-8 characters and the
#   JavaScript stemmers count UTF-16 code units, so these words test that
#   the two agree.
# - For the 16 algorithms whose word list in snowball-data has the BSD
#   license of Snowball (no COPYING file of its own), the first 500 words
#   and each 100th word of that list at a fixed commit. The script downloads
#   each list and checks its sha256. The words come only from the 16 lists
#   with the BSD license of Snowball and from the literals of each stemmer,
#   because the other lists have other licenses (GPL, CC BY-SA, CC BY).
import hashlib
import importlib.metadata
import json
import platform
import re
import sys
import urllib.request
from pathlib import Path

assert importlib.metadata.version("PyStemmer") == "3.1.0", importlib.metadata.version("PyStemmer")
assert platform.python_version() == "3.12.9", platform.python_version()

import Stemmer  # noqa: E402

HERE = Path(__file__).resolve().parent
SNOWBALL = HERE.parent.parent / "snowball"

# libstemmer/modules.txt of libstemmer_c 3.1.0: each algorithm and its names.
MODULES = {
    "arabic": ["arabic", "ar", "ara"],
    "armenian": ["armenian", "hy", "hye", "arm"],
    "basque": ["basque", "eu", "eus", "baq"],
    "catalan": ["catalan", "ca", "cat"],
    "czech": ["czech", "cs", "ces", "cze"],
    "danish": ["danish", "da", "dan"],
    "dutch": ["dutch", "nl", "dut", "nld", "kraaij_pohlmann"],
    "english": ["english", "en", "eng"],
    "esperanto": ["esperanto", "eo", "epo"],
    "estonian": ["estonian", "et", "est"],
    "finnish": ["finnish", "fi", "fin"],
    "french": ["french", "fr", "fre", "fra"],
    "german": ["german", "de", "ger", "deu"],
    "greek": ["greek", "el", "gre", "ell"],
    "hindi": ["hindi", "hi", "hin"],
    "hungarian": ["hungarian", "hu", "hun"],
    "indonesian": ["indonesian", "id", "ind"],
    "irish": ["irish", "ga", "gle"],
    "italian": ["italian", "it", "ita"],
    "lithuanian": ["lithuanian", "lt", "lit"],
    "nepali": ["nepali", "ne", "nep"],
    "norwegian": ["norwegian", "no", "nor"],
    "polish": ["polish", "pl", "pol"],
    "persian": ["persian", "fa", "fas", "pers"],
    "portuguese": ["portuguese", "pt", "por"],
    "romanian": ["romanian", "ro", "rum", "ron"],
    "russian": ["russian", "ru", "rus"],
    "serbian": ["serbian", "sr", "srp"],
    "spanish": ["spanish", "es", "esl", "spa"],
    "swedish": ["swedish", "sv", "swe"],
    "tamil": ["tamil", "ta", "tam"],
    "turkish": ["turkish", "tr", "tur"],
    "yiddish": ["yiddish", "yi", "yid"],
    "sesotho": ["sesotho", "st", "sot"],
    "porter": ["porter"],
    "dutch_porter": ["dutch_porter"],
}
assert sorted(MODULES) == Stemmer.algorithms(), Stemmer.algorithms()

# Each name of 1 to 3 lowercase ASCII letters that PyStemmer accepts must be
# a name above, so the list of short aliases is complete.
letters = "abcdefghijklmnopqrstuvwxyz"
short = [a + b + c for a in letters for b in [""] + list(letters) for c in [""] + list(letters) if b or not c]


def accepts(name: str) -> bool:
    try:
        Stemmer.Stemmer(name)
    except KeyError:
        return False
    return True


assert {name for name in short if accepts(name)} == {
    name for names in MODULES.values() for name in names if len(name) <= 3 and name.isalpha()
}

COMMIT = "019921c3a41c2b70063ee3feb215a00c8e594597"
BSD_LISTS = {
    "danish": "52ff4e8fff5875d79c5dd413254b477bae9677ec0547e898dd20ffc84159555d",
    "dutch": "09864bdd572eda800b291429cb16ba889024e461290a495a0bc7f7f6c2ff9921",
    "dutch_porter": "09864bdd572eda800b291429cb16ba889024e461290a495a0bc7f7f6c2ff9921",
    "english": "9e44b83e85d8b9c41ed40a0dd0d17a3ca9e7eb3a04683992982e7834f96ebc0f",
    "german": "6770f70c23bcbf8a08edb43c6604ba4548870a34db0dd1f48f33abc6af37143d",
    "hungarian": "e261c0e58be85b7c661d5919530ea54db3830e882d5c48e77c43416ef8cfd120",
    "irish": "d8873abed89e598fb870bc08d87389da943febeb1297bf2432ddbb1072549938",
    "nepali": "8edb711669c57d57981b027237b299d9c4c856027c343e6942bc1874456d5994",
    "norwegian": "0b117a23578b0282ee9d837359e97318eaec8f8edac6d955909ef4fd545189a8",
    "porter": "fe09ef577f1c8e4872b79a4f6995e62d782bbdbcda03f65a5ddd3e07b8b0044f",
    "portuguese": "f207664c28500f53f7d8294c891e842aa99261f4f42da3ec38712d82ea99ad08",
    "romanian": "a3eb4fefec1deeff8c7be15dcc7f0fe952cbec98564b95547af21340929ef11b",
    "russian": "6e4cd2ed5c908fe3d4cabaa74a088d9043cb626417c1eadc2c157cafbf9772a0",
    "spanish": "8ddebc629492c7c89488615af6590ec3a3eb392e0fec8ba2482aad0f3e9ea309",
    "swedish": "8a42eb66f2c9df47cfc37f91347531808191b35f732133079654ecc75ac1b62e",
    "turkish": "be3174a99eb68b5297a2bb3817944e09cfee924c9b4ab44f3c0026814a35777d",
}

# Letters outside the Basic Multilingual Plane: Deseret small letter long i,
# mathematical script small a, a CJK ideograph of extension B and an Adlam
# small letter.
ASTRAL = ["\U00010428", "\U0001d4b6", "\U00020000", "\U0001e922"]
# The first private use character, which pystemmer.ts uses for a letter
# outside the Basic Multilingual Plane unless the word holds it.
PRIVATE_USE = "\ue000"


def literals(algorithm: str) -> list[str]:
    source = (SNOWBALL / f"{algorithm}-stemmer.js").read_text(encoding="utf-8")
    found = {json.loads(f'"{literal}"') for literal in re.findall(r'"((?:[^"\\]|\\.)*)"', source)}
    return sorted(literal for literal in found if literal and " " not in literal)


def made_words(algorithm: str) -> list[str]:
    strings = literals(algorithm)
    n = len(strings)
    words = []
    for index, string in enumerate(strings):
        one = strings[(index * 7 + 1) % n]
        two = strings[(index * 11 + 3) % n]
        long = two + one + string
        astral = ASTRAL[index % 4]
        position = 1 + index % 4
        words += [
            string,
            long,
            long[:position] + astral + long[position:],
            one + astral + string,
        ]
        if index % 2 == 0:
            words.append(two + astral + one + ASTRAL[(index + 1) % 4] + string)
        if index < 4:
            words.append(one + PRIVATE_USE + astral + string)
    return words


def listed_words(algorithm: str) -> list[str]:
    url = f"https://raw.githubusercontent.com/snowballstem/snowball-data/{COMMIT}/{algorithm}/voc.txt"
    with urllib.request.urlopen(url) as response:
        data = response.read()
    assert hashlib.sha256(data).hexdigest() == BSD_LISTS[algorithm], algorithm
    lines = data.decode("utf-8").splitlines()
    return lines[:500] + lines[500::100]


words = {}
for algorithm in MODULES:
    listed = listed_words(algorithm) if algorithm in BSD_LISTS else []
    words[algorithm] = list(dict.fromkeys([""] + made_words(algorithm) + listed))

stems = {
    algorithm: [[word, stem] for word, stem in zip(algorithm_words, Stemmer.Stemmer(algorithm).stemWords(algorithm_words), strict=True)]
    for algorithm, algorithm_words in words.items()
}

# The probe list: the first 20 made words of each algorithm.
probe = [word for algorithm in MODULES for word in made_words(algorithm)[:20]]
aliases = {
    name: hashlib.sha256("\n".join(Stemmer.Stemmer(name).stemWords(probe)).encode("utf-8")).hexdigest()
    for names in MODULES.values()
    for name in names
}

errors = []
for name in ["", "English", "EN", "english ", "lovins", "kraaij-pohlmann", "é", "naïve name", "x😀y", "日本語", "zz"]:
    try:
        Stemmer.Stemmer(name)
    except (KeyError, UnicodeEncodeError) as error:
        errors.append([name, type(error).__name__, error.args[0] if isinstance(error, KeyError) else str(error)])
    else:
        raise AssertionError(name)

generator = f"generate.py: PyStemmer {importlib.metadata.version('PyStemmer')}, CPython {platform.python_version()}"
# One algorithm on each line keeps the file readable.
(HERE / "expected.json").write_text(
    "{\n"
    + f' "generator": {json.dumps(generator)},\n'
    + f' "probe": {json.dumps(probe, ensure_ascii=False)},\n'
    + f' "aliases": {json.dumps(aliases)},\n'
    + f' "errors": {json.dumps(errors, ensure_ascii=False)},\n'
    + ' "stems": {\n'
    + ",\n".join(f"  {json.dumps(algorithm)}: {json.dumps(pairs, ensure_ascii=False)}" for algorithm, pairs in stems.items())
    + "\n }\n}\n",
    encoding="utf-8",
)
print(f"{generator}: {sum(len(pairs) for pairs in stems.values())} stems", file=sys.stderr)
