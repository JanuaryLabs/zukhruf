import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * A port the host implements (a requester, a store) returns `unknown`, and
 * each consumer narrows it where it reads it. A generic response forces every
 * test stub to assert into T or to return `any`.
 */
export default selectorRule({
  description:
    'Disallow ports (interfaces and function types) whose methods are generic in their response',
  selectors: [
    ':matches(TSInterfaceDeclaration, TSTypeAliasDeclaration) :matches(TSMethodSignature, TSFunctionType, TSCallSignatureDeclaration)[typeParameters]',
  ],
  message:
    'A port must not be generic in its response. Return unknown and narrow at the call site.',
});
