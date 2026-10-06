import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * A raw path is a string the route table never sees: removing a route leaves
 * every link to it compiling. `href()` is checked against the registered
 * routes. Only identifier callees match, so `window.location.replace('/')`
 * stays a browser call.
 */
export default selectorRule({
  description:
    "Require internal paths in links and navigation to be built with react-router's href()",
  selectors: [
    'JSXAttribute[name.name="to"] > Literal[value=/^\\//]',
    'JSXAttribute[name.name="to"] > JSXExpressionContainer > :matches(Literal[value=/^\\//], TemplateLiteral[quasis.0.value.raw=/^\\//])',
    'CallExpression[callee.name=/^(navigate|redirect|replace)$/] > :matches(Literal[value=/^\\//], TemplateLiteral[quasis.0.value.raw=/^\\//]):first-child',
  ],
  message:
    "Raw internal path — build it with href('/path') from react-router so the route table checks it; append a query as `${href('/path')}?…`.",
});
