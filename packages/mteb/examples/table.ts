// Prints the scores of the ArguAna and SCIDOCS results in ~/.cache/mteb as a
// table, with a column for each model, and the mean of each model:
// nx run mteb:table
//
// The argument names another cache folder. A table averages the experiments
// of one model with its default run, as MTEB does.
import { ArguAna, ResultCache, SCIDOCS } from '../src/index.ts';

const results = new ResultCache(process.argv[2])
  .loadResults({ includeRemote: false, loadExperiments: 'match_name' })
  .selectTasks([new ArguAna(), new SCIDOCS()]);
console.log(results.toDataFrame().toString());
console.log();
console.table(results.getAggregatedScores());
