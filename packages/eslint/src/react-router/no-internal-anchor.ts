import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * A raw `<a>` to an internal path bypasses the client router and the route
 * table, so a link to a removed page ships green. The `(?!\/)` lookahead lets
 * protocol-relative URLs (`//cdn…`) through.
 */
export default selectorRule({
  description:
    "Disallow raw <a> elements to internal paths; use react-router's <Link>",
  selectors: [
    'JSXOpeningElement[name.name="a"] > JSXAttribute[name.name="href"][value.value=/^\\/(?!\\/)/]',
  ],
  message:
    "Internal path in a raw <a> — use <Link to={href('/path')}> from react-router so the route table checks it.",
});
