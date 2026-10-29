import { selectorRule } from '../authoring/selector-rule.ts';

const NEW_HTTP_EXCEPTION = "NewExpression[callee.name='HTTPException']";
const RETURNS_ONLY_HTTP_EXCEPTION = `BlockStatement[body.length=1]:has(> ReturnStatement:has(> ${NEW_HTTP_EXCEPTION}))`;

/**
 * A function that only returns `new HTTPException(…)` hides the status and the
 * cause code behind a name, so the reader at the throw site cannot see what
 * the client receives. Write the exception in full at each throw site; give a
 * function of its own only to behavior: a branch, a lookup, a transformation.
 * A class method that returns the exception is polymorphic translation and
 * stays.
 */
export default selectorRule({
  description:
    'Disallow a function whose only statement returns a new HTTPException',
  selectors: [
    `FunctionDeclaration:has(> ${RETURNS_ONLY_HTTP_EXCEPTION})`,
    `VariableDeclarator > :matches(FunctionExpression, ArrowFunctionExpression):has(> ${RETURNS_ONLY_HTTP_EXCEPTION})`,
    `VariableDeclarator > ArrowFunctionExpression:has(> ${NEW_HTTP_EXCEPTION})`,
  ],
  message:
    'This function only builds an HTTPException, so the status and the cause code are hidden at the throw site. Write throw new HTTPException(status, { message, cause }) in full where you throw it.',
});
