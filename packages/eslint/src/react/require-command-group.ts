import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

type Part = 'CommandItem' | 'CommandGroup' | 'CommandList';
const PARTS: ReadonlySet<string> = new Set<Part>([
  'CommandItem',
  'CommandGroup',
  'CommandList',
]);

function isPart(name: string): name is Part {
  return PARTS.has(name);
}

/** The local names that the file binds to the kit's Command parts. */
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
 * `CommandList` has no padding of its own (only `scroll-py-1`); `CommandGroup`
 * carries `p-1`. An item outside a group touches the list's edges, out of line
 * with `CommandInput` and the grouped items. shadcn's own
 * examples put every `CommandItem` in a `CommandGroup`, with `CommandEmpty`
 * and `CommandSeparator` straight in the list.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a CommandGroup between CommandList and CommandItem of @zukhruf/shadcn',
    },
    schema: [],
    messages: {
      ungrouped:
        "Wrap the items in `CommandGroup` from `@zukhruf/shadcn`: `<CommandList><CommandGroup><CommandItem /></CommandGroup></CommandList>`. `CommandList` has no padding of its own, and `CommandGroup` carries it. Without it an item touches the list's edges, out of line with the search input and with the items in a group.",
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

    /** The Command part nearest above `node`, or none when the walk leaves the file's JSX. */
    const enclosingPart = (node: TSESTree.Node): Part | undefined => {
      const parent = node.parent;
      if (parent === undefined || !passesThrough(parent)) return undefined;
      const part =
        parent.type === 'JSXElement'
          ? partOf(parent.openingElement.name)
          : undefined;
      return part === 'CommandGroup' || part === 'CommandList'
        ? part
        : enclosingPart(parent);
    };

    return {
      JSXElement(node) {
        if (
          partOf(node.openingElement.name) === 'CommandItem' &&
          enclosingPart(node) === 'CommandList'
        ) {
          context.report({ node: node.openingElement, messageId: 'ungrouped' });
        }
      },
    };
  },
});

export default eslintRule(rule);
