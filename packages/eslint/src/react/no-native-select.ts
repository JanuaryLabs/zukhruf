import { selectorRule } from '../authoring/selector-rule.ts';

/** The exports of @zukhruf/shadcn's `native-select.tsx`, which wrap `<select>`. */
const nativeSelectExport = /^NativeSelect(Option|OptGroup)?$/;
const shadcn = "[source.value='@zukhruf/shadcn']";

export default selectorRule({
  description:
    'Disallow `<select>` and NativeSelect; app code picks from a list with the Select of @zukhruf/shadcn',
  selectors: [
    "JSXOpeningElement[name.type='JSXIdentifier'][name.name='select']",
    `ImportDeclaration${shadcn} > ImportSpecifier[imported.name=${nativeSelectExport}]`,
    `ExportNamedDeclaration${shadcn} > ExportSpecifier[local.name=${nativeSelectExport}]`,
  ],
  message:
    'Do not use `<select>` or `NativeSelect`. Use `Select` from `@zukhruf/shadcn` with `SelectTrigger`, `SelectValue`, `SelectContent` and `SelectItem`. The root takes `name`, `required`, `multiple` and `defaultValue` and submits a hidden input, so `FormData` keeps working. Pass `items` (value to label) to the root, so the trigger shows the label, not the value: `<Select name="unit" items={unitLabels}>`.',
});
