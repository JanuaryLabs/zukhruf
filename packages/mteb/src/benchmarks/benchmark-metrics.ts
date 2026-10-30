// mteb/benchmarks/_benchmark_metrics.py: the means without a benchmark.
// getScore gives numpy float64 values, and Python's sum() adds a float
// subclass without compensation, so these sums are plain loops.
import type { TaskResult } from '../results/task-result.ts';

// _compute_mean_task: the mean score of the results; null when a score is
// missing or NaN, 0 without a result.
export function computeMeanTask(
  taskResults: readonly TaskResult[],
): number | null {
  const allScores = taskResults.map((result) => result.getScore());
  if (allScores.some((score) => Number.isNaN(score))) return null;
  return allScores.length > 0 ? plainSum(allScores) / allScores.length : 0;
}

// _compute_mean_task_type: the mean of the mean of each task type.
export function computeMeanTaskType(
  taskResults: readonly TaskResult[],
): number | null {
  const meanPerType = computeTaskTypes(taskResults);
  if (meanPerType === null) return null;
  const means = [...meanPerType.values()];
  return means.length > 0 ? plainSum(means) / means.length : 0;
}

// _compute_task_types: the mean score of each task type, in the order of
// the first result of each type.
export function computeTaskTypes(
  taskResults: readonly TaskResult[],
): Map<string, number> | null {
  const typeToScores = new Map<string, number[]>();
  let sawNull = false;
  for (const result of taskResults) {
    const score = result.getScore();
    if (Number.isNaN(score)) {
      sawNull = true;
      continue;
    }
    const scores = typeToScores.get(result.taskType) ?? [];
    scores.push(score);
    typeToScores.set(result.taskType, scores);
  }
  if (sawNull) return null;
  return new Map(
    [...typeToScores].map(([type, scores]) => [
      type,
      plainSum(scores) / scores.length,
    ]),
  );
}

function plainSum(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}
