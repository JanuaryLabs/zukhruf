import type { Rule } from 'eslint';

import { matchesAnyGlob } from '../authoring/path-scope.ts';
import { ISLAND_TAG } from '../nx-policy/island-constraint.ts';
import { isRecord, stringsAt } from '../unknown-values.ts';
import { projectOf } from '../workspace/project-manifest.ts';

/** Whether the linted file belongs to a project tagged `layer:island`. */
export function inIsland(context: Rule.RuleContext): boolean {
  return (
    projectOf(context.physicalFilename)?.tags.includes(ISLAND_TAG) ?? false
  );
}

/**
 * Library code: every island, plus the files `settings.island.libraries`
 * names. Library code takes values as options and reports through what it
 * returns or throws, so it never reads the environment or writes to console.
 */
export function inLibrary(context: Rule.RuleContext): boolean {
  return (
    inIsland(context) ||
    matchesAnyGlob(
      context.physicalFilename,
      // settings.island.libraries: workspace-relative globs for library code
      // outside islands.
      stringsAt(
        isRecord(context.settings) ? context.settings['island'] : undefined,
        'libraries',
      ),
    )
  );
}
