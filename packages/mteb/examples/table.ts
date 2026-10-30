// Prints the scores of the ArguAna and SCIDOCS results in ~/.cache/mteb as a
// table, with a column for each model and experiment, and the mean of each
// model and experiment:
// nx run mteb:table
//
// The argument names another cache folder. The experiment "" is the default
// run of a model.
import { ArguAna, ResultCache, SCIDOCS } from '../src/index.ts';

const results = new ResultCache(process.argv[2])
  .loadResults({ includeRemote: false, loadExperiments: 'match_name' })
  .selectTasks([new ArguAna(), new SCIDOCS()]);
console.log(results.toDataFrame({ includeExperiments: true }).toString());
console.log();
console.table(
  Object.entries(
    results.getAggregatedScores({ includeExperiments: true }),
  ).flatMap(([model, experiments]) =>
    Object.entries(experiments).map(([experiment, scores]) => ({
      model,
      experiment,
      ...scores,
    })),
  ),
);
