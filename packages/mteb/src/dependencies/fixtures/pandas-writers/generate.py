# /// script
# requires-python = "==3.12.9"
# dependencies = ["pandas==3.1.0", "numpy==2.5.4", "tabulate==0.10.0", "jinja2==3.1.6"]
# ///
# Makes the fixture of pandas-writers.golden.test.ts with pandas:
# uv run packages/mteb/src/dependencies/fixtures/pandas-writers/generate.py
#
# It builds each table as pd.DataFrame(rows, columns=...) and writes
# expected.json: the columns and rows of each table, and what to_csv,
# to_markdown, to_latex and to_latex(escape=True) give for it, all with
# index=False. The tables are the edge cases below and each table of
# ../../../results/fixtures/to-dataframe/expected.json, the tables of
# MTEB's to_dataframe. Never edit expected.json by hand: run this script
# again.
import importlib.metadata
import importlib.util
import json
import math
import platform
import sys
from pathlib import Path

VERSIONS = {
    "pandas": "3.1.0",
    "numpy": "2.5.4",
    "tabulate": "0.10.0",
    "jinja2": "3.1.6",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()
# tabulate measures the width of a text with wcwidth when it can import it,
# and with len otherwise. The port measures with len.
assert importlib.util.find_spec("wcwidth") is None, "wcwidth changes the widths of tabulate"

import pandas as pd  # noqa: E402

HERE = Path(__file__).resolve().parent
TO_DATAFRAME = HERE / "../../../results/fixtures/to-dataframe/expected.json"
NAN = math.nan
INF = math.inf

EDGE_CASES = [
    (
        "text that needs quotes, pipes and LaTeX specials",
        ["name", "note"],
        [
            ["a,b", 'say "hi"'],
            ["line\nbreak", "carriage\rreturn"],
            ["pipe | here", "& % $ # _ { } ~ ^ \\"],
            ["café ünïcode", "tab\there"],
            ["", " leading and trailing "],
        ],
    ),
    (
        "floats",
        ["model", "score"],
        [
            ["one", 1.0],
            ["small", 1e-05],
            ["large", 1e16],
            ["negative", -0.25],
            ["long", 0.123456789],
            ["million", 1234567.0],
            ["zero", 0.0],
            ["missing", NAN],
            ["infinite", INF],
            ["negative infinite", -INF],
            ["thousand", 1000.5],
        ],
    ),
    (
        "missing values in each kind of column",
        ["text", "number", "flag", "flag or none", "nothing"],
        [
            ["x", 0.5, True, True, None],
            [None, None, False, None, None],
            ["z", 2.0, True, False, None],
        ],
    ),
    (
        "a column of numbers and text",
        ["mixed", "score"],
        [
            [1.0, 0.1],
            ["text", 0.2],
            [True, 0.3],
            [None, 0.4],
            [0.5, 0.5],
        ],
    ),
    (
        "MultiIndex columns with empty sub-labels and repeated top labels",
        [["task_name", ""], ["is_public", ""], ["org/model", "r1"], ["org/model", "r2"], ["other/model", "r1"]],
        [
            ["ArguAna", True, 0.5, NAN, 0.25],
            ["SCI_DOCS & co", False, 0.0344535, 12.25, None],
        ],
    ),
    (
        "three column levels",
        [
            ["task_name", "", ""],
            ["ndcg_at_10", "org/model", "k1_1.2"],
            ["ndcg_at_10", "org/model", ""],
            ["ndcg_at_10", "other/model", ""],
            ["recall_at_10", "org/model", "k1_1.2"],
        ],
        [["ArguAna", 0.5, 0.6, 0.7, 0.8]],
    ),
    (
        "a table without rows",
        ["model_name", "score"],
        [],
    ),
    (
        "text that tabulate reads as numbers",
        ["revision", "count", "flag text", "exponent", "int text"],
        [
            ["0_3_0", "1,000", "True", "1e5", "7"],
            ["b22da4", "12", "False", "2.5", "0_3_0"],
            ["1.2.3", "1,234,567.5", "yes", "nan", " 42 "],
        ],
    ),
    (
        "rounding ties",
        ["name", "score"],
        [
            ["fixed tie", 0.0078125],
            ["g tie", 1234565.0],
            ["half", 2.5],
            ["large", 1e21],
            ["tiny negative", -1e-9],
        ],
    ),
    (
        "equal labels under different labels above",
        [["a", "x", "1"], ["b", "x", "2"], ["b", "x", "3"], ["b", "y", "3"]],
        [[0.1, 0.2, 0.3, 0.4]],
    ),
    (
        "quotes and a tab in MultiIndex labels",
        [["it's", "a"], ["b", 'say "x"'], ["tab\there", "c"]],
        [[1.0, 2.0, 3.0]],
    ),
    (
        "one column with an empty text and a missing value",
        ["only"],
        [[""], ["x"], [None]],
    ),
    (
        "a header and a cell on two lines",
        ["multi\nline header", "score"],
        [["a", 1.5], ["b\nc", 2.25], ["", 3.0]],
    ),
    (
        "Unicode whitespace around text",
        ["text"],
        [[chr(0x3000) + "ideographic" + chr(0xA0)], ["plain"]],
    ),
]


def value(cell):
    if cell == "NaN":
        return NAN
    if cell == "Infinity":
        return INF
    if cell == "-Infinity":
        return -INF
    return cell


def to_dataframe_tables():
    expected = json.loads(TO_DATAFRAME.read_text(encoding="utf-8"))
    tables = [("empty", expected["empty"])]
    for key in ("model_results", "benchmark_results", "maximum", "experiment_tables"):
        for index, entry in enumerate(expected[key]):
            tables.append((f"{key}[{index}]", entry["table"]))
    return [
        (f"to-dataframe {name}", table["columns"], [[value(cell) for cell in row] for row in table["rows"]])
        for name, table in tables
    ]


def frame(columns, rows):
    if columns and all(isinstance(column, list) for column in columns):
        index = pd.MultiIndex.from_tuples([tuple(column) for column in columns])
    else:
        index = pd.Index(columns, dtype=object)
    return pd.DataFrame(rows, columns=index)


def cell(value):
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value).replace("nan", "NaN").replace("inf", "Infinity")
    return value


entries = []
for name, columns, rows in EDGE_CASES + to_dataframe_tables():
    df = frame(columns, rows)
    entries.append(
        {
            "name": name,
            "columns": columns,
            "rows": [[cell(item) for item in row] for row in rows],
            "csv": df.to_csv(index=False),
            "markdown": df.to_markdown(index=False),
            "latex": df.to_latex(index=False),
            "latex_escaped": df.to_latex(index=False, escape=True),
        }
    )

generator = (
    f"generate.py: pandas {VERSIONS['pandas']}, numpy {VERSIONS['numpy']}, "
    f"tabulate {VERSIONS['tabulate']}, jinja2 {VERSIONS['jinja2']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps({"generator": generator, "tables": entries}, ensure_ascii=False, indent=1) + "\n",
    encoding="utf-8",
)
print(f"{generator}: {len(entries)} tables", file=sys.stderr)
