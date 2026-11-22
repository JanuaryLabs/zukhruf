import citedLines from './pg-boss-citations/cited-lines.ts';
import citedVersion from './pg-boss-citations/cited-version.ts';

// @nx/eslint-plugin loads this file and serves each rule as
// `@nx/workspace-<name>` (its resolve-workspace-rules.js).
export const rules = {
  'pg-boss-cited-lines': citedLines,
  'pg-boss-cited-version': citedVersion,
};
