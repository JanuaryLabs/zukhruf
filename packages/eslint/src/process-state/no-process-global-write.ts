import { selectorRule } from '../authoring/selector-rule.ts';

const GLOBAL = '/^(globalThis|window|global|self)$/';
/** `console`, or `console` read off the global object. */
const CONSOLE = `:matches(Identifier[name="console"], MemberExpression[object.name=${GLOBAL}][property.name="console"])`;

/**
 * One process shares one `console`: code that replaces it or one of its
 * methods changes what every module of the process logs, and nothing at a
 * call site shows that the patch is installed. Shipped code mounts on a seam
 * that already runs on the path (a logger or `enrich` option the caller
 * passes); a test replaces a method with `t.mock.method(console, 'error')`,
 * which node:test restores when the test ends. Reading console and calling
 * its methods stay allowed.
 */
export default selectorRule({
  description:
    'Disallow a write to a process-wide global: replacing console or one of its methods',
  selectors: [
    `AssignmentExpression > ${CONSOLE}.left`,
    `AssignmentExpression > MemberExpression.left > ${CONSOLE}.object`,
    `CallExpression[callee.object.name="Object"][callee.property.name=/^(assign|defineProperty|defineProperties)$/] > ${CONSOLE}.arguments:first-child`,
  ],
  message:
    'console is one object for the whole process: a patch changes what every module logs, and no call site shows it. In shipped code, pass a logger or an enrich option to the code that logs; in a test, use t.mock.method(console, …), which node:test restores when the test ends.',
});
