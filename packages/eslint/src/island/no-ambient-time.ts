import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

/**
 * A library that waits on a timer or reads the time takes the clock as an
 * input, so a test can give it a fake clock (zukhruf root ADR 0004). This rule
 * reports each read of the time that does not go through a clock: the global
 * timers and time sources, called or as values, the same through
 * `globalThis` or `global`, the timers of `node:timers` and the `performance`
 * of `node:perf_hooks`. Code that runs on real time on purpose gives
 * `globalThis` to a clock-taking function, as an app does. `setImmediate` is a
 * turn of the event loop, not a time, and `new Date(value)` converts a value.
 * Names resolve through scope, so a local binding with a global's name passes.
 */

const timers = new Set(['setTimeout', 'setInterval', 'scheduler']);
const performance = new Set(['performance']);
// The modules that give a timer or a time source, and the names that do.
const timeModules = new Map([
  ['node:timers', timers],
  ['node:timers/promises', timers],
  ['timers', timers],
  ['timers/promises', timers],
  ['node:perf_hooks', performance],
  ['perf_hooks', performance],
]);
const globalObjects = new Set(['globalThis', 'global']);
const timeGlobals = [
  'Date',
  'performance',
  'process',
  'AbortSignal',
  'Temporal',
  'setTimeout',
  'setInterval',
];

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading the time or starting a timer in library code except through a clock that the caller gives',
    },
    schema: [],
    messages: {
      ambient:
        "Library code must not read the time or start a timer by itself ({{read}}). Take a clock from the caller and use it, as @zukhruf/async's delay, timeout and poll do; an app gives globalThis.",
      timers:
        'Library code must not take {{name}} from {{module}}. Take a clock from the caller and read the time from it, or wait on it with delay or timeout of @zukhruf/async.',
    },
  },
  create(context) {
    const report = (node: AstNode | undefined, read: string) => {
      if (node) context.report({ node, messageId: 'ambient', data: { read } });
    };

    // A member of a time global, such as `Date.now`, read from `object`,
    // which is the global itself or `globalThis.<global>`.
    const checkGlobal = (name: string, object: AstNode) => {
      const parent = object['parent'];
      // A timer function as a value, called or not, for example in
      // promisify(setTimeout). typeof in a type reads nothing.
      if (name === 'setTimeout' || name === 'setInterval') {
        if (!isType(parent, 'TSTypeQuery')) report(object, name);
        return;
      }
      if (name === 'Date') {
        const use = parentOf(object);
        if (
          (isType(use, 'NewExpression') || isType(use, 'CallExpression')) &&
          use['callee'] === object &&
          argumentCount(use) === 0
        ) {
          report(use, isType(use, 'NewExpression') ? 'new Date()' : 'Date()');
          return;
        }
      }
      if (!isMemberOf(parent, object)) return;
      const member = propertyName(parent);
      // A read of the member, called or not, for example now = Date.now.
      if (name === 'Date' && member === 'now') {
        report(parent, 'Date.now');
      } else if (name === 'performance' && member === 'now') {
        report(parent, 'performance.now');
      } else if (name === 'AbortSignal' && member === 'timeout') {
        report(parent, 'AbortSignal.timeout');
      } else if (name === 'process' && member === 'hrtime') {
        report(parent, 'process.hrtime');
      } else if (name === 'Temporal' && member === 'Now') {
        report(parent, 'Temporal.Now');
      }
    };

    return {
      ImportDeclaration(declaration) {
        if (!isAstNode(declaration)) return;
        const source = declaration['source'];
        const module = isType(source, 'Literal') ? source['value'] : undefined;
        const names = typeof module === 'string' && timeModules.get(module);
        if (!names) return;
        for (const specifier of specifiersOf(declaration)) {
          const imported = isType(specifier, 'ImportSpecifier')
            ? identifierName(specifier['imported'])
            : undefined;
          const whole =
            isType(specifier, 'ImportNamespaceSpecifier') ||
            isType(specifier, 'ImportDefaultSpecifier');
          if (whole || (imported && names.has(imported))) {
            context.report({
              node: specifier,
              messageId: 'timers',
              data: { name: whole ? 'the module' : imported, module },
            });
          }
        }
      },
      'Program:exit'(program) {
        const scope = context.sourceCode.getScope(program);
        for (const name of [...timeGlobals, ...globalObjects]) {
          for (const identifier of globalReferences(scope, name)) {
            if (globalObjects.has(name)) {
              const parent = identifier['parent'];
              if (!isMemberOf(parent, identifier)) continue;
              const member = propertyName(parent);
              if (member && timeGlobals.includes(member))
                checkGlobal(member, parent);
            } else {
              checkGlobal(name, identifier);
            }
          }
        }
      },
    };
  },
};

export default rule;

/** The identifiers that read the global `name`, unless a local binding shadows it. */
function globalReferences(
  scope: ReturnType<Rule.RuleContext['sourceCode']['getScope']>,
  name: string,
): AstNode[] {
  const declared = scope.set.get(name);
  if (declared?.defs.length) return [];
  const references =
    declared?.references ??
    scope.through.filter(({ identifier }) => identifier.name === name);
  return references
    .map(({ identifier }) => identifier)
    .filter((identifier) => isAstNode(identifier));
}

function parentOf(node: AstNode): AstNode | undefined {
  const parent = node['parent'];
  return isAstNode(parent) ? parent : undefined;
}

function isMemberOf(parent: unknown, object: AstNode): parent is AstNode {
  return isType(parent, 'MemberExpression') && parent['object'] === object;
}

function propertyName(member: AstNode): string | undefined {
  const property = member['property'];
  if (member['computed'] === true)
    return isType(property, 'Literal') && typeof property['value'] === 'string'
      ? property['value']
      : undefined;
  return identifierName(property);
}

function argumentCount(call: AstNode): number {
  const args = call['arguments'];
  return Array.isArray(args) ? args.length : 0;
}

function specifiersOf(declaration: AstNode): AstNode[] {
  const specifiers: unknown = declaration['specifiers'];
  return Array.isArray(specifiers)
    ? specifiers.filter((specifier) => isAstNode(specifier))
    : [];
}
