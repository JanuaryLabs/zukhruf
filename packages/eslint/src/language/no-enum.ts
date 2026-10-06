import { selectorRule } from '../authoring/selector-rule.ts';

export default selectorRule({
  description:
    'Disallow TypeScript enums, which Node cannot run with types stripped',
  selectors: ['TSEnumDeclaration'],
  message:
    'No TS enums — they need a runtime transform and break Node strip-only `.ts` execution (tsc/bundlers hide it). Use a `const` object + a union type under a different name instead (`const Colors = {…} as const; type Color = (typeof Colors)[keyof typeof Colors]`) — `no-redeclare` flags a value and type sharing a name.',
});
