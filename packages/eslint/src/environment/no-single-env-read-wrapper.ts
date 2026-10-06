import type { Rule } from 'eslint';

import { identifierName, isAstNode, isType } from '../authoring/ast.ts';

function isProcessEnvRead(node: unknown): boolean {
  if (!isType(node, 'MemberExpression')) {
    return false;
  }
  const object = node['object'];
  if (!isType(object, 'MemberExpression')) {
    return false;
  }
  return (
    identifierName(object['object']) === 'process' &&
    identifierName(object['property']) === 'env' &&
    object['computed'] !== true
  );
}

function isTrivialEnvExpression(node: unknown): boolean {
  if (isProcessEnvRead(node)) {
    return true;
  }
  if (
    isType(node, 'LogicalExpression') &&
    (node['operator'] === '||' || node['operator'] === '??')
  ) {
    return isProcessEnvRead(node['left']) && isType(node['right'], 'Literal');
  }
  return false;
}

function bodyReturnsOnlyProcessEnv(body: unknown): boolean {
  if (isTrivialEnvExpression(body)) {
    return true;
  }
  if (!isType(body, 'BlockStatement')) {
    return false;
  }
  const statements = body['body'];
  if (!Array.isArray(statements) || statements.length !== 1) {
    return false;
  }
  const [statement]: readonly unknown[] = statements;
  return (
    isType(statement, 'ReturnStatement') &&
    isTrivialEnvExpression(statement['argument'])
  );
}

/**
 * An accessor that only returns `process.env.X` (or `process.env.X ?? 'literal'`)
 * hides which variable a call site reads and invites validation to grow there
 * instead of in the startup schema. Async and generator functions change the
 * return type, so inlining them is not equivalent and they are left alone.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow a function whose only job is to return a single process.env read — read process.env inline at the use site',
    },
    messages: {
      trivialWrapper:
        'Do not wrap a single process.env read in a function. Read `process.env.X` inline at the use site (env validation/transform belongs in the startup schema, not an accessor helper).',
    },
    schema: [],
  },
  create(context) {
    function check(node: Rule.Node) {
      if (!isAstNode(node)) {
        return;
      }
      if (node['async'] === true || node['generator'] === true) {
        return;
      }
      if (bodyReturnsOnlyProcessEnv(node['body'])) {
        context.report({ node, messageId: 'trivialWrapper' });
      }
    }

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
};

export default rule;
