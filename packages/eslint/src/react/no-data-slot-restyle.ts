import type { Rule } from 'eslint';

import { KIT_SLOTS } from './kit-slots.ts';

/**
 * A slot that a Tailwind class names: `data-[slot=input]` in
 * `*:data-[slot=input]:h-12`, and `[data-slot=input]` in
 * `[&_[data-slot=input]]:h-12` or `has-[[data-slot=input]]:pl-2`.
 */
const slotReference = /(?:data-\[slot=|\[data-slot=)(['"]?)([\w-]+)\1\]/g;

/**
 * The kit slots that `className` restyles through a variant: the slot sits
 * before a `:` of the same class, so a CSS selector string such as
 * `'[data-slot=field-error]'` names no variant.
 */
function restyledSlots(className: string): string[] {
  return className
    .split(/\s+/)
    .flatMap((token) =>
      [...token.matchAll(slotReference)]
        .filter((match) => token.includes(':', match.index + match[0].length))
        .map((match) => match[2] ?? ''),
    )
    .filter((slot) => KIT_SLOTS.has(slot));
}

/** A string in a JSX `className` (or `…ClassName`) prop, or in a class helper call. */
const classContext =
  ':matches(JSXAttribute[name.name=/className$/i], CallExpression[callee.name=/^(cn|clsx|cva)$/])';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow restyling a part of @zukhruf/shadcn from a parent through its data-slot; restyling belongs in the kit',
    },
    schema: [],
    messages: {
      restyle:
        'Do not restyle the `{{slot}}` part of `@zukhruf/shadcn` from a parent through its `data-slot` (`[&_[data-slot=input]]:h-12`, `*:data-[slot=select-value]:text-primary`). Use the part as installed, with its own variants and sizes. When a screen needs a look the kit lacks, add the variant or size to `@zukhruf/shadcn`.',
    },
  },
  create(context) {
    const check = (node: Rule.Node, className: string) => {
      for (const slot of new Set(restyledSlots(className))) {
        context.report({ node, messageId: 'restyle', data: { slot } });
      }
    };
    return {
      [`${classContext} Literal`](node: Rule.Node) {
        if (node.type === 'Literal' && typeof node.value === 'string') {
          check(node, node.value);
        }
      },
      [`${classContext} TemplateElement`](node: Rule.Node) {
        if (node.type === 'TemplateElement') check(node, node.value.raw);
      },
    };
  },
};

export default rule;
