import { selectorRule } from '../authoring/selector-rule.ts';

const BANNED_WORD = '[name=/ingredient/i]';

export default selectorRule({
  description:
    'Disallow "ingredients" in a declared name, a cooking metaphor with no engineering meaning',
  // The names a file declares. A property or a member key often mirrors data
  // the code does not own, such as a field of a recipe API, so keys pass.
  selectors: [
    `VariableDeclarator > Identifier.id${BANNED_WORD}`,
    `:function > Identifier.id${BANNED_WORD}`,
    `:matches(ClassDeclaration, ClassExpression) > Identifier.id${BANNED_WORD}`,
    `:matches(TSTypeAliasDeclaration, TSInterfaceDeclaration, TSEnumDeclaration) > Identifier.id${BANNED_WORD}`,
  ],
  message:
    'Do not name an API "ingredients": it is a cooking metaphor, not an engineering term. Name what the parts are, such as Extension, Mixin, Contribution, Module, Parts or Bundle.',
});
