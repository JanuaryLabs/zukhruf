import { selectorRule } from '../authoring/selector-rule.ts';

export default selectorRule({
  description: 'Disallow reading process.env in library code',
  selectors: [
    "MemberExpression[object.name='process']:matches([computed=false][property.name='env'], [computed=true][property.value='env'])",
    "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
  ],
  message:
    'Library code must not read process.env. Take the value as an option the library types; the host reads its environment.',
});
