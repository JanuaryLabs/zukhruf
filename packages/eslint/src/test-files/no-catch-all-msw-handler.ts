import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * msw 3 sends a request that no handler matches to the network unless the
 * strategy is strict, and a request that a catch-all handler matches but does
 * not answer goes to the network too. So `http.all('*', () => {})` turns the
 * strict strategy off for every origin. Scoped to a file that imports msw; a
 * handler made with a `RegExp` built at run time is not seen.
 */
export default selectorRule({
  description:
    'Disallow an msw handler that matches every request; match the origin',
  selectors: [
    'Program:has(ImportDeclaration[source.value="msw"]) CallExpression[callee.object.name="http"]:matches([arguments.0.value="*"], [arguments.0.regex.pattern=/^\\^?\\.[*+]\\$?$/])',
  ],
  message:
    'A catch-all handler that returns nothing sends unmatched requests to the network and turns the strict strategy off (msw 3). Match the origin: http.all(`${origin}/*`, () => passthrough()).',
});
