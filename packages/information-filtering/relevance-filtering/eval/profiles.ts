import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVAL_FOLDER } from './answer-key.ts';

export type EvalProfile = {
  readonly id: string;
  readonly description: string;
  // The keyword baselines: narrow is the stem a reader types first, and
  // broad adds the obvious related words (keywords.json). Case-insensitive.
  readonly narrow: RegExp;
  readonly broad: RegExp;
};

// The 16 profiles of the answer key, in the order of profiles.json, with the
// keyword baselines of keywords.json. The research matched the Python
// regular expressions with re.I; each one has the same meaning in
// JavaScript.
export function readProfiles(): EvalProfile[] {
  const profiles: { profiles: { id: string; description: string }[] } =
    JSON.parse(readFileSync(join(EVAL_FOLDER, 'profiles.json'), 'utf8'));
  const keywords: {
    baselines: Record<string, { narrow: string; broad: string }>;
  } = JSON.parse(readFileSync(join(EVAL_FOLDER, 'keywords.json'), 'utf8'));
  return profiles.profiles.map(({ id, description }) => {
    const baseline = keywords.baselines[id];
    if (baseline === undefined) throw new Error(`keywords.json has no ${id}.`);
    return {
      id,
      description,
      narrow: new RegExp(baseline.narrow, 'i'),
      broad: new RegExp(baseline.broad, 'i'),
    };
  });
}
