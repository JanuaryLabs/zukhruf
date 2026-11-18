import { dirname, join } from 'node:path';

import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { isRecord } from '../unknown-values.ts';
import { readJson } from '../workspace/project-manifest.ts';

/** The keys of the `nx` key of the package.json at `path`, as Nx reads them. */
function packageNxKeys(path: string): Set<string> {
  try {
    const manifest = readJson(path);
    const nx = isRecord(manifest) ? manifest['nx'] : undefined;
    return new Set(isRecord(nx) ? Object.keys(nx) : []);
  } catch (error) {
    // A package.json that does not parse is its own lint error.
    if (error instanceof SyntaxError) return new Set();
    throw error;
  }
}

/**
 * Nx reads a project's `project.json` and the `nx` key of its `package.json`,
 * and merges the two. A key that both set is split across two files, so a
 * reader of one does not see the whole project. The rule runs on the
 * project.json and reads the package.json beside it from disk.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a project.json key that the nx key of the package.json beside it also sets',
    },
    schema: [],
    messages: {
      duplicate:
        '"{{key}}" is set here and in the "nx" key of package.json. Nx merges the two, so neither file shows the whole value. Keep "{{key}}" in one file.',
    },
  },
  create(context) {
    const nxKeys = packageNxKeys(
      join(dirname(context.physicalFilename), 'package.json'),
    );
    if (nxKeys.size === 0) return {};
    return {
      'JSONExpressionStatement > JSONObjectExpression'(project: Rule.Node) {
        if (!isType(project, 'JSONObjectExpression')) return;
        for (const [key, property] of objectProperties(project)) {
          if (!nxKeys.has(key)) continue;
          context.report({
            node: property,
            messageId: 'duplicate',
            data: { key },
          });
        }
      },
    };
  },
};

export default rule;
