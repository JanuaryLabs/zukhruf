import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * A bare `c.json([])` widens the route's response to `any[]`, which a client
 * generated from the routes can then not iterate. Matches the conventional
 * Hono context name `c` only.
 */
export default selectorRule({
  description:
    'Require an empty array returned from a Hono route to state its element type',
  selectors: [
    "CallExpression[callee.object.name='c'][callee.property.name='json'] > ArrayExpression[elements.length=0]",
  ],
  message:
    'Empty c.json([]) widens the response type — write c.json([] satisfies Model[]) so the generated client stays typed.',
});
