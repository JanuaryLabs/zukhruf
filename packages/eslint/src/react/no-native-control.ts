import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

const SHADCN = '@zukhruf/shadcn';

/** The exports of @zukhruf/shadcn's `native-select.tsx`, which wrap `<select>`. */
const nativeSelectExport = /^NativeSelect(Option|OptGroup)?$/;

/** The components of @zukhruf/shadcn that render an `<input>` with the `type` they are given. */
const KIT_INPUTS: ReadonlySet<string> = new Set([
  'Input',
  'InputGroupInput',
  'SidebarInput',
]);

type Control = 'select' | 'date' | 'checkbox' | 'radio' | 'range';

/**
 * The `type`s of `<input>` whose widget the browser draws and for which
 * @zukhruf/shadcn has a component. `time`, `file` and `color` have none, and
 * the text-like types draw no widget.
 */
const INPUT_TYPES: ReadonlyMap<string, Control> = new Map<string, Control>([
  ['date', 'date'],
  ['datetime-local', 'date'],
  ['checkbox', 'checkbox'],
  ['radio', 'radio'],
  ['range', 'range'],
]);

/**
 * ESLint reads `{{ name }}` in a message as a placeholder and has no escape
 * for it. Each `{{` becomes the placeholder `{{open}}`, which the report fills
 * with `{{`, so `disabled={{ after: today }}` reads as written (as in
 * `selectorRule`).
 */
const open = { open: '{{' };
const literal = (message: string) => message.replaceAll('{{', '{{open}}');

/** The local names that the file binds to the kit's inputs and to the kit. */
function kitBindings(program: TSESTree.Program) {
  const inputs = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.source.value !== SHADCN
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name);
      } else if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        KIT_INPUTS.has(specifier.imported.name)
      ) {
        inputs.set(specifier.local.name, specifier.imported.name);
      }
    }
  }
  return { inputs, namespaces };
}

/**
 * The string literals that an attribute value can be: `"date"`, `{'date'}`,
 * and each literal branch of a conditional, `{multiple ? 'checkbox' : 'radio'}`.
 * A branch that is not a literal gives nothing.
 */
function literalValues(
  node: TSESTree.Node | null | undefined,
): readonly string[] {
  if (node == null) return [];
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'TemplateLiteral':
      return node.expressions.length === 0
        ? node.quasis.map((quasi) => quasi.value.cooked ?? '')
        : [];
    case 'JSXExpressionContainer':
      return node.expression.type === 'JSXEmptyExpression'
        ? []
        : literalValues(node.expression);
    case 'ConditionalExpression':
      return [
        ...literalValues(node.consequent),
        ...literalValues(node.alternate),
      ];
    default:
      return [];
  }
}

/** The controls that the `type` attribute of an input can make, each once. */
function controlsOf(element: TSESTree.JSXOpeningElement): Set<Control> {
  const type = element.attributes.find(
    (attribute): attribute is TSESTree.JSXAttribute =>
      attribute.type === 'JSXAttribute' &&
      attribute.name.type === 'JSXIdentifier' &&
      attribute.name.name === 'type',
  );
  const controls = new Set<Control>();
  for (const value of literalValues(type?.value)) {
    const control = INPUT_TYPES.get(value.trim().toLowerCase());
    if (control !== undefined) controls.add(control);
  }
  return controls;
}

/**
 * A control whose widget the browser draws, where @zukhruf/shadcn has its own:
 * `<select>` and `NativeSelect`, and an `<input>` or an input of the kit
 * (`Input`, `InputGroupInput`, `SidebarInput`, which render one) of type
 * `date`, `datetime-local`, `checkbox`, `radio` or `range`. The browser's
 * widget ignores the theme, the direction and the locale of the app.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a control that the browser draws where @zukhruf/shadcn has its own: `<select>`, NativeSelect, and an `<input>` or an input of the kit of type date, datetime-local, checkbox, radio or range',
    },
    schema: [],
    messages: {
      select: literal(
        'Do not use `<select>` or `NativeSelect`. Use `Select` from `@zukhruf/shadcn` with `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectGroup` and `SelectItem`. The root takes `name`, `required`, `multiple` and `defaultValue` and submits a hidden input, so `FormData` keeps working. Pass `items` (value to label) to the root, so the trigger shows the label, not the value: `<Select name="unit" items={unitLabels}>`.',
      ),
      date: literal(
        'Do not use an `<input>`, `Input` or `InputGroupInput` of type `date` or `datetime-local`: the browser draws its popup. Pick a date with `Popover`, `PopoverTrigger render={<Button variant="outline" />}` and `Calendar mode="single"` from `@zukhruf/shadcn`. Compose them in the app: the package holds no app compositions. Put the day in `<input type="hidden" name="…" value="yyyy-MM-dd">`, built from the local day, never from `toISOString()`, so `FormData` keeps working. Set a bound with `disabled={{ after: today }}`, not `max`. For a birth date, set `captionLayout="dropdown"` with `startMonth` and `endMonth`. For `datetime-local`, put the `Input type="time"` of `@zukhruf/shadcn` beside it, as the example of shadcn does.',
      ),
      checkbox: literal(
        'Do not use an `<input>`, `Input` or `InputGroupInput` of type `checkbox`: the browser draws it. Use `Checkbox` from `@zukhruf/shadcn`. Its `name` submits a hidden input with the value `on`, so `FormData` keeps working. For an on/off setting, use `Switch`.',
      ),
      radio: literal(
        'Do not use an `<input>`, `Input` or `InputGroupInput` of type `radio`: the browser draws it. Use `RadioGroup` with `RadioGroupItem` from `@zukhruf/shadcn`. The `name` of the group submits the value of the checked item.',
      ),
      range: literal(
        'Do not use an `<input>`, `Input` or `InputGroupInput` of type `range`: the browser draws it. Use `Slider` from `@zukhruf/shadcn`. Its `name` submits the value.',
      ),
    },
  },
  create(context) {
    const { inputs, namespaces } = kitBindings(context.sourceCode.ast);

    /** The kit export that a JSX name stands for, when it is one. */
    const kitName = (name: TSESTree.JSXTagNameExpression) => {
      if (name.type === 'JSXIdentifier') return inputs.get(name.name);
      if (
        name.type === 'JSXMemberExpression' &&
        name.object.type === 'JSXIdentifier' &&
        namespaces.has(name.object.name)
      ) {
        return name.property.name;
      }
      return undefined;
    };

    const report = (node: TSESTree.Node, messageId: Control) =>
      context.report({ node, messageId, data: open });

    return {
      ImportDeclaration(node) {
        if (node.source.value !== SHADCN) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            nativeSelectExport.test(specifier.imported.name)
          ) {
            report(specifier, 'select');
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== SHADCN) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.local.type === 'Identifier' &&
            nativeSelectExport.test(specifier.local.name)
          ) {
            report(specifier, 'select');
          }
        }
      },
      JSXOpeningElement(node) {
        const { name } = node;
        const native = name.type === 'JSXIdentifier' ? name.name : undefined;
        const kit = kitName(name);
        if (native === 'select' || nativeSelectExport.test(kit ?? '')) {
          report(node, 'select');
        } else if (native === 'input' || KIT_INPUTS.has(kit ?? '')) {
          for (const control of controlsOf(node)) report(node, control);
        }
      },
    };
  },
});

export default eslintRule(rule);
