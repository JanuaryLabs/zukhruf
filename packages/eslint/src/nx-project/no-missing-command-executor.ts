import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { projectTargets } from './targets.ts';

/** The options of `nx:run-commands` that hold the shell commands. */
const COMMAND_OPTIONS = new Set(['command', 'commands']);

/**
 * Nx turns a target's top-level `command` into `nx:run-commands`, but it never
 * reads `options` to pick an executor. A target with no executor becomes
 * `nx:noop` when it has a `dependsOn`, and Nx drops it otherwise, so the
 * target passes and its command never runs. A target default or an inferred
 * target can give the executor, but the file does not show it, so the target
 * names its executor itself.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an executor in a target that sets options.command: without one, Nx runs the target as nx:noop and the command never runs',
    },
    schema: [],
    messages: {
      missingExecutor:
        'Target "{{target}}" sets options.{{option}} but no executor. Nx picks no executor from options, so the target becomes nx:noop and passes without running the command. Set "executor": "nx:run-commands", or move the command to the target\'s top-level "command".',
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
          const keys = new Map(objectProperties(target));
          if (keys.has('executor') || keys.has('command')) continue;
          const options = objectProperties(keys.get('options')?.['value']);
          for (const [option, property] of options) {
            if (!COMMAND_OPTIONS.has(option)) continue;
            context.report({
              node: property,
              messageId: 'missingExecutor',
              data: { target: name, option },
            });
          }
        }
      },
    };
  },
};

export default rule;
