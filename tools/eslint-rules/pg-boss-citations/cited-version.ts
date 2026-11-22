import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Rule } from 'eslint';

const RECORD = 'pg-boss-citations.json';

/** The version that the record beside `manifest` names; `undefined` when there is no record or it names none. */
function citedVersion(manifest: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dirname(manifest), RECORD), 'utf8');
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const record: unknown = JSON.parse(text);
  const version =
    typeof record === 'object' && record !== null && 'pg-boss' in record
      ? record['pg-boss']
      : undefined;
  return typeof version === 'string' ? version : undefined;
}

function stringValue(property: Rule.Node): string | undefined {
  const value = 'value' in property ? property.value : undefined;
  return typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string'
    ? value.value
    : undefined;
}

/**
 * The pg-boss pin of a package.json equals the version that the citations of
 * the package name, which pg-boss-citations.json beside it records. A bump of
 * the pin then fails until the citations are moved to the lines of the new
 * version.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require the pg-boss pin of a package.json to equal the version that the package's line citations name",
    },
    schema: [],
    messages: {
      cited:
        'pg-boss is pinned to {{pinned}}, but the citations of this package name the lines of {{cited}} (' +
        RECORD +
        '). Install, then run `npx nx run sqlite-queue:repoint-citations` before you change any citation: it moves each citation to the line of {{pinned}} and records it.',
      unrecorded:
        'pg-boss is pinned to {{pinned}}, but no ' +
        RECORD +
        ' beside this package.json records the version that the citations of this package name. Write {"pg-boss": "<version>"} there, with the version whose lines the citations name.',
    },
  },
  create(context) {
    return {
      "JSONExpressionStatement > JSONObjectExpression > JSONProperty[key.value='dependencies'] > JSONObjectExpression > JSONProperty[key.value='pg-boss']"(
        pin: Rule.Node,
      ) {
        const pinned = stringValue(pin);
        if (pinned === undefined) return;
        const cited = citedVersion(context.physicalFilename);
        if (cited === pinned) return;
        context.report(
          cited === undefined
            ? { node: pin, messageId: 'unrecorded', data: { pinned } }
            : { node: pin, messageId: 'cited', data: { pinned, cited } },
        );
      },
    };
  },
};

export default rule;
