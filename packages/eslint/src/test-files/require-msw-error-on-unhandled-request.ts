import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * msw answers only what a handler lists. Without this option an unstubbed
 * request is warned about and sent to the real network, so the test passes on
 * a live dependency it never meant to touch. msw 3 names the option
 * `onUnhandledFrame`; msw 2 named it `onUnhandledRequest`. Scoped by the
 * `msw/node` import; a `listen()` on something else in the same file, called
 * with no argument or an object, is the one known false positive.
 */
export default selectorRule({
  description: "Require msw's server.listen() to fail on unhandled requests",
  selectors: [
    'Program:has(ImportDeclaration[source.value="msw/node"]) CallExpression[callee.property.name="listen"]:matches([arguments.length=0], [arguments.0.type="ObjectExpression"]):not(:has(Property[key.name=/^onUnhandled(Frame|Request)$/] > Literal[value="error"]))',
  ],
  message:
    "msw: server.listen() must pass { onUnhandledFrame: 'error' } (msw 2: onUnhandledRequest) so an unstubbed request fails the test instead of reaching the network.",
});
