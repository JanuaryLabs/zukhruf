# /// script
# requires-python = "==3.12.*"
# dependencies = []
# ///
"""Writes expected.json: what CPython 3.12 gives for each case of the tests
of @zukhruf/python. Floats cross as the hex of their 8 bytes, so no float is
rounded on the way. Never edit expected.json by hand; run
`uv run --no-project --python 3.12 generate.py` in this folder."""

import json
import random
import re
import struct
import sys
import unicodedata

assert sys.version_info[:2] == (3, 12), sys.version


def bits(value: float) -> str:
    return struct.pack(">d", value).hex()


def tagged(value):
    """A json.loads value with its Python type written out."""
    if value is None or isinstance(value, bool):
        return {"type": "constant", "value": value}
    if isinstance(value, int):
        return {"type": "int", "digits": str(value)}
    if isinstance(value, float):
        return {"type": "float", "bits": bits(value)}
    if isinstance(value, str):
        return {"type": "str", "code_points": [ord(char) for char in value]}
    if isinstance(value, list):
        return {"type": "list", "items": [tagged(item) for item in value]}
    return {"type": "dict", "items": [[key, tagged(item)] for key, item in value.items()]}


generator = random.Random(42)


def random_double() -> float:
    while True:
        value = struct.unpack(">d", generator.getrandbits(64).to_bytes(8, "big"))[0]
        if value == value and abs(value) != float("inf"):
            return value


sums = [
    [0.1] * 10,
    [1.0, 1e100, 1.0, -1e100],
    [1e308, 1e308, -1e308],
    [-0.0],
    [],
    [0.1, 0.2, 0.3],
    [1e16, 1.0, -1e16],
    [-173723439301235.47, -157001288447995.3, -4.360692165494287e-21],
    [float("inf"), 1.0],
    [float("inf"), float("-inf")],
    [float("nan"), 1.0],
    [1.0, float("-inf")],
] + [
    [generator.uniform(-1e6, 1e6) for _ in range(generator.randrange(1, 40))]
    for _ in range(200)
]

reprs = [
    1.0, 1e16, 1e15, 1e-05, 0.0001, 123456789012345680.0, -0.0, 0.0, 0.1, 1.5,
    100.0, 5e-324, 1.7976931348623157e308, 2.0**53, float("nan"), float("inf"),
    float("-inf"), 123.456, 1234567.125, 0.000123, 99999999999999.98,
] + [random_double() for _ in range(2000)] + [generator.uniform(-1e6, 1e6) for _ in range(500)]

big_int = "9" * 4300
too_big_int = "9" * 4301
texts = [
    '{"b": 1, "10": 2.0, "2": 1.0, "a": 12345678901234567890, "b": 3}',
    "[NaN, Infinity, -Infinity, 1]",
    "1", "1.0", "1e2", "1E2", "-0", "-0.0", "7.0", "1e400", "-1e400",
    '{"a": {"b": [1, 2.5, null, true, false, "x"]}}',
    '"\\ud800"', '"\\ud83d\\ude00"', '"caf\\u00e9"',
    '{"a": "\\"NaN", "b": NaN}',
    '["\\\\", NaN, "Infinity", -Infinity]',
    " \t\n 1 \r",
    big_int,
    "-" + big_int,
    "[" + big_int + "]",
]
errors = {
    '{"a": 1,}': "JSONDecodeError",
    "// note\n1": "JSONDecodeError",
    "{NaN: 1}": "JSONDecodeError",
    "": "JSONDecodeError",
    "[1] [2]": "JSONDecodeError",
    '"\x01"': "JSONDecodeError",
    "nan": "JSONDecodeError",
    too_big_int: "ValueError",
    "-" + too_big_int: "ValueError",
    '{"a": [' + too_big_int + "]}": "ValueError",
    "{'a': 1}": "JSONDecodeError",
    "01": "JSONDecodeError",
    "-": "JSONDecodeError",
    "[1, 2": "JSONDecodeError",
    '{"a": 1': "JSONDecodeError",
    '"abc': "JSONDecodeError",
    "[1, 2,]": "JSONDecodeError",
    "[1,,2]": "JSONDecodeError",
    '"\\x41"': "JSONDecodeError",
    "[-NaN]": "JSONDecodeError",
    "\u00a01": "JSONDecodeError",
}

loads = []
for text in texts:
    loads.append({"text": text, "value": tagged(json.loads(text))})
for text, error in errors.items():
    try:
        json.loads(text)
        raise AssertionError(f"json.loads read {text!r}")
    except json.JSONDecodeError:
        assert error == "JSONDecodeError", text
    except ValueError:
        assert error == "ValueError", text
    loads.append({"text": text, "error": error})

def ranges(codes):
    """Code points as [first, last] runs, so the file stays small."""
    runs = []
    for code in codes:
        if runs and runs[-1][1] == code - 1:
            runs[-1][1] = code
        else:
            runs.append([code, code])
    return runs


WORD_RE = re.compile(r"\w")

expected = {
    "python": sys.version.split()[0],
    "sums": [
        {
            "values": [bits(value) for value in values],
            "sum": bits(float(sum(values))),
            "prefixes": [bits(float(sum(values[: index + 1]))) for index in range(len(values))],
        }
        for values in sums
    ],
    "reprs": [{"bits": bits(value), "repr": repr(value)} for value in reprs],
    "loads": loads,
    "isspace": [code for code in range(0x110000) if chr(code).isspace()],
    "unicode": unicodedata.unidata_version,
    "word": ranges(code for code in range(0x110000) if WORD_RE.match(chr(code))),
    "unassigned": ranges(
        code for code in range(0x110000) if unicodedata.category(chr(code)) == "Cn"
    ),
}

with open("expected.json", "w", encoding="ascii") as file:
    json.dump(expected, file, ensure_ascii=True, indent=1)
    file.write("\n")
