import { selectorRule } from '../authoring/selector-rule.ts';

const numberFormat =
  ":matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name='NumberFormat'] > ObjectExpression";

/**
 * Hermes on iOS ignores `notation: 'compact'` and `compactDisplay` without an
 * error: `format(44000)` gives `44,000`, not `44K`.
 */
export default selectorRule({
  description:
    "Disallow notation: 'compact' and compactDisplay in Intl.NumberFormat options, which Hermes on iOS ignores",
  selectors: [
    `${numberFormat} > Property:matches([key.name='notation'], [key.value='notation'])[value.value='compact']`,
    `${numberFormat} > Property:matches([key.name='compactDisplay'], [key.value='compactDisplay'])`,
  ],
  message:
    "Hermes on iOS ignores notation: 'compact' and compactDisplay, and formats the full number. Build the short form yourself.",
});
