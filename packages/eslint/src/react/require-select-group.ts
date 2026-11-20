import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

type Part = 'SelectItem' | 'SelectGroup' | 'SelectContent';
const PARTS: ReadonlySet<string> = new Set<Part>([
  'SelectItem',
  'SelectGroup',
  'SelectContent',
]);

function isPart(name: string): name is Part {
  return PARTS.has(name);
}

/** The local names that the file binds to the kit's Select parts. */
function kitBindings(program: TSESTree.Program) {
  const named = new Map<string, Part>();
  const namespaces = new Set<string>();
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.source.value !== '@zukhruf/shadcn'
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name);
      } else if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        isPart(specifier.imported.name)
      ) {
        named.set(specifier.local.name, specifier.imported.name);
      }
    }
  }
  return { named, namespaces };
}

function isMapCallback(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  return (
    call?.type === 'CallExpression' &&
    call.arguments[0] === fn &&
    call.callee.type === 'MemberExpression' &&
    call.callee.property.type === 'Identifier' &&
    (call.callee.property.name === 'map' ||
      call.callee.property.name === 'flatMap')
  );
}

/**
 * The nodes an item passes through on its way into the JSX that holds it: JSX
 * children, fragments, `{…}`, conditionals, and the body of a `.map(…)` or
 * `?.map(…)` callback. Any other node (a variable, a prop, a function that is
 * not a map callback) hands the item to code this rule does not follow.
 */
function passesThrough(node: TSESTree.Node): boolean {
  switch (node.type) {
    case 'JSXElement':
    case 'JSXFragment':
    case 'JSXExpressionContainer':
    case 'ConditionalExpression':
    case 'LogicalExpression':
    case 'CallExpression':
    case 'ChainExpression':
    case 'ReturnStatement':
    case 'BlockStatement':
    case 'IfStatement':
      return true;
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return isMapCallback(node);
    default:
      return false;
  }
}

/**
 * `SelectContent` puts its children straight into Base UI's `Select.List`,
 * which has no padding; `SelectGroup` carries `p-1`. An item outside a group
 * touches the popup's border, and `alignItemWithTrigger` shifts the popup
 * sideways off its trigger.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a SelectGroup between SelectContent and SelectItem of @zukhruf/shadcn',
    },
    schema: [],
    messages: {
      ungrouped:
        "Wrap the items in `SelectGroup` from `@zukhruf/shadcn`: `<SelectContent><SelectGroup><SelectItem /></SelectGroup></SelectContent>`. `SelectContent`'s list has no padding of its own, and `SelectGroup` carries it. Without it an item touches the popup's border, and the popup, which lines up the item's text with the trigger's text, sits off its trigger.",
    },
  },
  create(context) {
    const { named, namespaces } = kitBindings(context.sourceCode.ast);
    if (named.size === 0 && namespaces.size === 0) return {};

    const partOf = (name: TSESTree.JSXTagNameExpression): Part | undefined => {
      if (name.type === 'JSXIdentifier') return named.get(name.name);
      if (
        name.type === 'JSXMemberExpression' &&
        name.object.type === 'JSXIdentifier' &&
        namespaces.has(name.object.name) &&
        isPart(name.property.name)
      ) {
        return name.property.name;
      }
      return undefined;
    };

    /** The Select part nearest above `node`, or none when the walk leaves the file's JSX. */
    const enclosingPart = (node: TSESTree.Node): Part | undefined => {
      const parent = node.parent;
      if (parent === undefined || !passesThrough(parent)) return undefined;
      const part =
        parent.type === 'JSXElement'
          ? partOf(parent.openingElement.name)
          : undefined;
      return part === 'SelectGroup' || part === 'SelectContent'
        ? part
        : enclosingPart(parent);
    };

    return {
      JSXElement(node) {
        if (
          partOf(node.openingElement.name) === 'SelectItem' &&
          enclosingPart(node) === 'SelectContent'
        ) {
          context.report({ node: node.openingElement, messageId: 'ungrouped' });
        }
      },
    };
  },
});

export default eslintRule(rule);
