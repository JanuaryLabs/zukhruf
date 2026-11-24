/**
 * The collation of every id, model identity and source that the retrievers
 * compare or order: UTF-16 code units, the order of JavaScript's `sort()`,
 * whatever the collation of the database is. A case-insensitive default
 * would make `a` and `A` one id.
 */
export const binary = 'COLLATE Latin1_General_100_BIN2';
