# /// script
# requires-python = ">=3.12"
# dependencies = ["mteb==2.26.28", "plotly==7.1.0"]
# ///
# Draws the ArguAna and SCIDOCS scores in ~/.cache/mteb as a bar chart for
# each model that compare-models.ts ran: nx run mteb:chart
#
# Python MTEB reads the result files of the port. include_remote=False keeps
# out MTEB's results repository, and pandas draws the bars with plotly, the
# library of MTEB's leaderboard.
import mteb
import pandas as pd

pd.options.plotting.backend = "plotly"
cache = mteb.ResultCache()
results = cache.load_results(
    tasks=["ArguAna", "SCIDOCS"],
    include_remote=False,
    load_experiments="match_name",
)
path = cache.cache_path / "chart.html"
(
    results.to_dataframe()
    .drop(columns="is_public")
    .set_index("task_name")
    .plot.bar(barmode="group", title="nDCG@10")
    .write_html(path)
)
print(path)
