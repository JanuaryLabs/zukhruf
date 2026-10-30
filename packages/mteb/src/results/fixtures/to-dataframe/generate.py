# /// script
# requires-python = "==3.12.9"
# dependencies = ["mteb==2.26.28", "pandas==3.1.0", "numpy==2.5.4", "torch==2.14.1", "datasets==5.1.0"]
# ///
# Makes the fixture of to-dataframe.golden.test.ts with Python MTEB:
# uv run packages/mteb/src/results/fixtures/to-dataframe/generate.py
#
# It writes a result cache next to this file (results/) with MTEB's own
# TaskResult and ResultCache, loads it with ResultCache.load_results, and
# writes expected.json: each table of ModelResult.to_dataframe and
# BenchmarkResults.to_dataframe (4 aggregation levels, 2 formats, with and
# without the model revision), two tables with np.max as the aggregation, and
# get_aggregated_scores. Never edit expected.json by hand: run this script
# again.
#
# The results test the tables: a model with 2 revisions whose join takes
# tasks from both, a model with an experiment (MTEB averages it with the
# default run), a NaN main score, a main score of None, a subset that only
# the None has (a row of NaN only), a subset with no language,
# a subset of 2 languages, 3 splits, and for each model a task of 20 scores
# whose float sum depends on the order and method of the summation.
import importlib.metadata
import json
import math
import platform
import random
import shutil
import sys
from pathlib import Path

VERSIONS = {
    "mteb": "2.26.28",
    "pandas": "3.1.0",
    "numpy": "2.5.4",
    "datasets": "5.1.0",
}
for name, version in VERSIONS.items():
    assert importlib.metadata.version(name) == version, (name, importlib.metadata.version(name))
assert platform.python_version() == "3.12.9", platform.python_version()

import mteb  # noqa: E402
import numpy as np  # noqa: E402
from mteb.models.model_meta import ModelMeta  # noqa: E402
from mteb.results import BenchmarkResults, TaskResult  # noqa: E402

HERE = Path(__file__).resolve().parent
TASKS = ["ArguAna", "SCIDOCS", "AmazonCounterfactualClassification"]
for task_name in TASKS:
    # A task that is not public would have is_public False, which the port
    # cannot know: it has no task registry.
    assert mteb.get_task(task_name).metadata.is_public, task_name

LANGUAGES = {
    "en": ["eng-Latn"],
    "de": ["deu-Latn"],
    "ja": ["jpn-Jpan"],
    "en-ext": ["eng-Latn", "deu-Latn"],
}
draw = random.Random(3379)


def subset(name, score, languages=None):
    return {
        "hf_subset": name,
        "languages": LANGUAGES.get(name, ["eng-Latn"]) if languages is None else languages,
        "main_score": score,
    }


def retrieval(score):
    return {"test": [subset("default", score)]}


def classification(scores=None, extra=()):
    # Three splits of four subsets: twelve times 0.1 sums to 1.2 in a plain
    # loop and to 1.2000000000000002 in a compensated sum.
    return {
        split: [subset(name, draw.random() if scores is None else scores) for name in LANGUAGES]
        + [subset(*item) for item in extra]
        for split in ("validation", "test", "train")
    }


def write(cache, meta, task_name, scores, mteb_version="2.26.28"):
    result = TaskResult(
        dataset_revision="fixture",
        task_name=task_name,
        mteb_version=mteb_version,
        scores=scores,
        evaluation_time=1.0,
        kg_co2_emissions=None,
    )
    cache.save_to_cache(result, meta)


shutil.rmtree(HERE / "results", ignore_errors=True)
cache = mteb.ResultCache(cache_path=HERE)


def meta(name, revision, **experiment_kwargs):
    overwrites = {"name": name, "revision": revision}
    if experiment_kwargs:
        overwrites["experiment_kwargs"] = experiment_kwargs
    return ModelMeta.create_empty(overwrites)


# zukhruf/model-a: r1 ran the 3 tasks with an older MTEB, r2 ran 2 of them.
# The join takes ArguAna and SCIDOCS from r2 and the classification from r1.
a1 = meta("zukhruf/model-a", "r1")
write(cache, a1, "ArguAna", retrieval(draw.random()), "2.26.0")
write(cache, a1, "SCIDOCS", retrieval(draw.random()), "2.26.0")
write(cache, a1, "AmazonCounterfactualClassification", classification(0.1), "2.26.0")
a2 = meta("zukhruf/model-a", "r2")
write(cache, a2, "ArguAna", retrieval(draw.random()))
write(cache, a2, "SCIDOCS", retrieval(draw.random()))

# zukhruf/model-b: a default run and the experiment k1_1.2, whose SCIDOCS
# main score is NaN. The default run scores a classification mean of
# 0.7000000000000001, then 0.2 and 0.1: their sum is 1.0000000000000002 in a
# plain loop and 1.0 in a compensated one.
b = meta("zukhruf/model-b", "r1")
write(cache, b, "ArguAna", retrieval(0.2))
write(cache, b, "SCIDOCS", retrieval(0.1))
write(cache, b, "AmazonCounterfactualClassification", classification(0.7))
b_k1 = meta("zukhruf/model-b", "r1", k1=1.2)
write(cache, b_k1, "ArguAna", retrieval(draw.random()))
write(cache, b_k1, "SCIDOCS", retrieval(math.nan))
write(cache, b_k1, "AmazonCounterfactualClassification", classification())

# zukhruf/model-c: no SCIDOCS, a main score of None in the subset "fr" that
# no other model has, and a subset with no language. A missing main score
# cannot be made: TaskResult refuses scores without one.
c = meta("zukhruf/model-c", "r1")
write(cache, c, "ArguAna", retrieval(draw.random()))
write(
    cache,
    c,
    "AmazonCounterfactualClassification",
    classification(extra=[("fr", None, ["fra-Latn"]), ("xx", draw.random(), [])]),
)

results = cache.load_results(include_remote=False, load_experiments="match_name")


def cell(value):
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value).replace("nan", "NaN").replace("inf", "Infinity")
    return value


def label(column):
    return list(column) if isinstance(column, tuple) else column


def table(frame):
    return {
        "columns": [label(column) for column in frame.columns],
        "rows": [[cell(value) for value in row] for row in frame.itertuples(index=False, name=None)],
    }


COMBINATIONS = [
    (level, output_format, include_model_revision)
    for level in ("subset", "split", "task", "language")
    for output_format in ("wide", "long")
    for include_model_revision in (False, True)
]


def options(level, output_format, include_model_revision):
    return {
        "aggregation_level": level,
        "format": output_format,
        "include_model_revision": include_model_revision,
    }


model_results = [
    {
        "model": [model.model_name, model.model_revision, model.experiment_name],
        "options": options(*combination),
        "table": table(model.to_dataframe(**options(*combination))),
    }
    for model in results
    for combination in COMBINATIONS
]
benchmark_results = [
    {
        "options": options(*combination),
        "table": table(results.to_dataframe(**options(*combination))),
    }
    for combination in COMBINATIONS
]
maximum = [
    {
        "options": options(level, output_format, False),
        "table": table(results.to_dataframe(aggregation_fn=np.max, **options(level, output_format, False))),
    }
    for level, output_format in (("task", "wide"), ("subset", "long"))
]
# The test gives these results their tasks with select_tasks, which would
# drop the subsets "fr" and "xx" of model-c: the aggregated scores leave
# model-c out. With the experiment, model-b has a NaN score; without it,
# model-b has scores of 2 task types.
aggregated = {
    load_experiments: cache.load_results(include_remote=False, load_experiments=load_experiments)
    .select_models(["zukhruf/model-a", "zukhruf/model-b"])
    .get_aggregated_scores()
    for load_experiments in ("match_name", "no_experiments")
}

generator = (
    f"generate.py: mteb {VERSIONS['mteb']}, pandas {VERSIONS['pandas']}, "
    f"numpy {VERSIONS['numpy']}, CPython {platform.python_version()}"
)
(HERE / "expected.json").write_text(
    json.dumps(
        {
            "generator": generator,
            "model_results": model_results,
            "benchmark_results": benchmark_results,
            "maximum": maximum,
            "empty": table(BenchmarkResults(model_results=[]).to_dataframe()),
            "aggregated": [
                [
                    load_experiments,
                    [
                        [model, [[key, cell(value)] for key, value in scores.items()]]
                        for model, scores in by_model.items()
                    ],
                ]
                for load_experiments, by_model in aggregated.items()
            ],
        },
        ensure_ascii=False,
        indent=1,
    )
    + "\n",
    encoding="utf-8",
)
tables = [entry["table"] for entry in model_results + benchmark_results + maximum]
print(
    f"{generator}: {len(tables)} tables, {sum(len(t['rows']) * len(t['columns']) for t in tables)} cells",
    file=sys.stderr,
)
