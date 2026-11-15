// A settle's result with `settled` sorted: pg-boss aggregates the ids it
// touched in no specified order (node_modules/pg-boss/dist/plans.js:
// 2413-2415).
export const sortSettled = <T extends { settled?: string[] }>(response: T) => ({
  ...response,
  settled: response.settled?.toSorted(),
});
