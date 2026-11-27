# /// script
# requires-python = "==3.12.9"
# dependencies = ["statsmodels==0.15.0", "numpy==2.5.4"]
# ///
# Makes the fixture of holm.golden.test.ts: the Holm adjusted p-values of
# statsmodels' multipletests(p, method="holm")[1] for each case. The cases
# cover one value, p-values out of order, equal p-values (ties keep their
# order), adjusted values above 1 (capped at 1), a running maximum (a later
# rank that a smaller product would lower), the p-values of a bootstrap
# (0 and 1 among them), and 28 random p-values. The p-values are literals:
# they came from the fixture of @zukhruf/mteb, whose generator drew the
# random ones and the bootstrap ones before Holm moved here (#6111). Never
# edit expected.json by hand: run this script again.
# uv run packages/statistics/src/fixtures/holm/generate.py
import json
import pathlib
import sys

import numpy
import statsmodels
from statsmodels.stats.multitest import multipletests

CASES = [
    ("one value", [0.03]),
    ("out of order", [0.04, 0.001, 0.03, 0.2, 0.01]),
    ("equal values", [0.01, 0.02, 0.01, 0.02, 0.5, 0.01]),
    ("above 1", [0.6, 0.4, 0.9, 0.35]),
    ("running maximum", [0.01, 0.012, 0.3, 0.0125]),
    ("bootstrap p", [0.98, 1, 0, 0, 0, 0.044]),
    (
        "28 random",
        [
            0.018091295728144975, 0.8880146619133912, 0.4084181701618911,
            0.024846533501511916, 0.5402186719590086, 0.37824794457814737,
            0.016267337412432116, 0.00022516250540061122, 0.06636446909422233,
            0.058319292148132196, 0.8404248439387411, 0.2449383101982655,
            0.0029465645688359745, 0.45860307051918314, 0.7664004696993139,
            0.05193463814323066, 0.6412452336706472, 0.35558122193397257,
            0.032354855775304024, 0.4179059771236019, 0.23265230797755254,
            0.0706643206022191, 0.6342812332806176, 0.9373680100852615,
            0.025589529388527765, 0.04290539726293552, 0.8584579215913087,
            0.08274385335062369,
        ],
    ),
]

out = pathlib.Path(__file__).with_name("expected.json")
out.write_text(
    json.dumps(
        {
            "generator": f"statsmodels {statsmodels.__version__}, numpy {numpy.__version__}",
            "cases": [
                {"case": case, "p": p, "adjusted": [float(v) for v in multipletests(p, method="holm")[1]]}
                for case, p in CASES
            ],
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
print(f"{len(CASES)} holm cases", file=sys.stderr)
