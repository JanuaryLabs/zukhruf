import type { Rule } from 'eslint';

import { type AstNode, isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { runsTestsWithoutTimeout } from './command-scripts.ts';
import { projectTargets } from './targets.ts';

const RUN_COMMANDS = 'nx:run-commands';

function isString(node: unknown): node is AstNode {
  return isType(node, 'JSONLiteral') && typeof node['value'] === 'string';
}

/**
 * The command lines of a target that `nx:run-commands` runs: the top-level
 * `command`, `options.command`, and each entry of `options.commands`, a line
 * or an object with a `command`. The options of another executor are its own.
 */
function commandLines(target: AstNode): AstNode[] {
  const keys = new Map(objectProperties(target));
  const executor = keys.get('executor')?.['value'];
  if (
    executor !== undefined &&
    !(isString(executor) && executor['value'] === RUN_COMMANDS)
  ) {
    return [];
  }
  const options = new Map(objectProperties(keys.get('options')?.['value']));
  const commands = options.get('commands')?.['value'];
  const entries: unknown[] =
    isType(commands, 'JSONArrayExpression') &&
    Array.isArray(commands['elements'])
      ? commands['elements']
      : [];
  return [
    keys.get('command')?.['value'],
    options.get('command')?.['value'],
    ...entries.map((entry) =>
      isType(entry, 'JSONObjectExpression')
        ? new Map(objectProperties(entry)).get('command')?.['value']
        : entry,
    ),
  ].filter(isString);
}

/**
 * A wait in a test ends on `t.signal` (`zukhruf/no-own-wait-limit`), and
 * `t.signal` aborts only at the runner's `--test-timeout`. Node's own limit is
 * Infinity, so a target that runs `node --test` without the flag lets a hung
 * wait run until the CI job limit. The test target that `@zukhruf/nx` infers
 * sets the flag; a target written by hand sets it itself.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require --test-timeout in a target that runs node --test: t.signal aborts only at the runner limit',
    },
    schema: [],
    messages: {
      missingTestTimeout:
        'Target "{{target}}" runs node --test without --test-timeout. t.signal aborts only at the runner\'s --test-timeout, and Node sets none, so a hung wait runs until the CI job limit. Add --test-timeout=300000, the limit that the test target of @zukhruf/nx sets.',
    },
  },
  create(context) {
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        for (const { name, target } of projectTargets(
          manifest,
          context.physicalFilename,
        )) {
          for (const line of commandLines(target)) {
            if (!runsTestsWithoutTimeout(String(line['value']))) continue;
            context.report({
              node: line,
              messageId: 'missingTestTimeout',
              data: { target: name },
            });
          }
        }
      },
    };
  },
};

export default rule;
