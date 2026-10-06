import type { Rule } from 'eslint';

import { type AstNode, isAstNode, isType } from '../authoring/ast.ts';

interface PlainTag {
  readonly opening: AstNode;
  readonly name: AstNode;
  readonly text: string;
}

// The opening tag of a JSX element, but only for the plain-identifier form
// (`<Popover>`). The member/namespaced forms (`<Popover.Root>`) are not this
// rule's concern — the shadcn wrapper this rule guards is always used as a bare
// identifier.
function plainTag(node: unknown): PlainTag | undefined {
  if (!isType(node, 'JSXElement')) return undefined;
  const opening = node['openingElement'];
  if (!isAstNode(opening)) return undefined;
  const name = opening['name'];
  if (!isType(name, 'JSXIdentifier') || typeof name['name'] !== 'string') {
    return undefined;
  }
  return { opening, name, text: name['name'] };
}

type ModalState =
  | { readonly kind: 'ok' } // shorthand `modal`, `modal={true}`, dynamic, or spread
  | { readonly kind: 'absent' }
  | { readonly kind: 'false'; readonly attribute: AstNode };

function readModal(opening: AstNode): ModalState {
  const attributes = opening['attributes'];
  const list: readonly unknown[] = Array.isArray(attributes) ? attributes : [];
  let hasSpread = false;
  for (const attribute of list) {
    if (isType(attribute, 'JSXSpreadAttribute')) {
      hasSpread = true;
      continue;
    }
    if (!isType(attribute, 'JSXAttribute')) continue;
    const name = attribute['name'];
    if (!isType(name, 'JSXIdentifier') || name['name'] !== 'modal') continue;

    const value = attribute['value'];
    if (value === null) return { kind: 'ok' }; // `<Popover modal>`
    if (isType(value, 'JSXExpressionContainer')) {
      const expression = value['expression'];
      if (isType(expression, 'Literal') && expression['value'] === false) {
        return { kind: 'false', attribute };
      }
    }
    // `modal={true}`, `modal={someVar}`, `modal="..."` — leave the author's
    // explicit/dynamic choice alone.
    return { kind: 'ok' };
  }

  // A spread could supply `modal` at runtime; too imprecise to flag.
  return hasSpread ? { kind: 'ok' } : { kind: 'absent' };
}

/**
 * A modal <Dialog> locks scrolling with react-remove-scroll, which lets wheel
 * events through only inside the dialog's subtree. A combobox <Popover> portals
 * to document.body, outside that subtree, so its list silently stops scrolling
 * with the wheel unless the popover holds its own lock (`modal`).
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: {
      description:
        'Require `modal` on a <Popover> that wraps a <Command> combobox so wheel scrolling survives inside a modal <Dialog>',
    },
    messages: {
      requireModal:
        'A <Popover> wrapping a <Command> combobox must set `modal`. Rendered inside a modal <Dialog>, react-remove-scroll allows wheel events only within the dialog subtree; this popover portals to document.body, so without its own lock the wheel is silently canceled (arrow keys still work via cmdk scrollIntoView). Add `modal`, or disable this line if this popover is never mounted inside a modal Dialog.',
      noExplicitFalse:
        '`modal={false}` on a <Popover> wrapping a <Command> combobox reintroduces the wheel-scroll bug inside a modal <Dialog>. Remove it (default to `modal`), or disable this line if this popover is never mounted inside a modal Dialog.',
    },
    schema: [],
  },
  create(context) {
    const reported = new Set<AstNode>();

    return {
      JSXElement(node: Rule.Node) {
        if (plainTag(node)?.text !== 'Command') return;

        // The nearest syntactic ancestor, so an enclosing <Popover> is matched
        // only when the <Command> is genuinely nested inside it in the same
        // file — the co-located shadcn combobox shape — never a sibling
        // <Popover> elsewhere in the module.
        const popover = context.sourceCode
          .getAncestors(node)
          .map(plainTag)
          .findLast((tag) => tag?.text === 'Popover');
        if (!popover || reported.has(popover.opening)) return;

        const modal = readModal(popover.opening);
        if (modal.kind === 'ok') return;
        reported.add(popover.opening);

        if (modal.kind === 'absent') {
          context.report({
            node: popover.opening,
            messageId: 'requireModal',
            fix: (fixer) => fixer.insertTextAfter(popover.name, ' modal'),
          });
          return;
        }

        context.report({ node: modal.attribute, messageId: 'noExplicitFalse' });
      },
    };
  },
};

export default rule;
