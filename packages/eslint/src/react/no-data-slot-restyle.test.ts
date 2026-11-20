import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import { KIT_SLOTS } from './kit-slots.ts';
import rule from './no-data-slot-restyle.ts';

test('no-data-slot-restyle', () => {
  typescriptRuleTester().run('no-data-slot-restyle', rule, {
    valid: [
      { code: 'const x = <Input className="h-12" />;', filename: 'a.tsx' },
      // A slot that no part of the kit renders belongs to the host.
      {
        code: `const x = <ChatBot className="**:data-[slot='content']:max-w-3xl" />;`,
        filename: 'a.tsx',
      },
      // A CSS selector names no variant.
      {
        code: "const error = form.querySelector('[data-slot=field-error]');",
        filename: 'a.tsx',
      },
      {
        code: 'const x = <div data-slot="input" className="h-12" />;',
        filename: 'a.tsx',
      },
      // Only a class string is read.
      {
        code: "expect(className).toContain('*:data-[slot=input]:h-12');",
        filename: 'a.tsx',
      },
    ],
    invalid: [
      {
        code: 'const x = <main className="[&_[data-slot=field-label]]:text-ink-2 [&_[data-slot=input]]:h-12 [&_[data-slot=button].w-full]:h-11.5" />;',
        filename: 'a.tsx',
        errors: [
          { messageId: 'restyle', data: { slot: 'field-label' } },
          { messageId: 'restyle', data: { slot: 'input' } },
          { messageId: 'restyle', data: { slot: 'button' } },
        ],
      },
      {
        code: `const x = <AgentScrollArea className="[&>[data-slot='scroll-area-viewport']]:px-4" />;`,
        filename: 'a.tsx',
        errors: [
          { messageId: 'restyle', data: { slot: 'scroll-area-viewport' } },
        ],
      },
      {
        code: 'const x = <Command className="**:data-[slot=command-input-wrapper]:h-auto" />;',
        filename: 'a.tsx',
        errors: [
          { messageId: 'restyle', data: { slot: 'command-input-wrapper' } },
        ],
      },
      {
        code: "const x = <SelectTrigger className={cn('h-9', active && '*:data-[slot=select-value]:text-primary')} />;",
        filename: 'a.tsx',
        errors: [{ messageId: 'restyle', data: { slot: 'select-value' } }],
      },
      {
        code: 'const x = <Field className={`gap-2 has-[[data-slot=checkbox]]:${gap} dark:*:data-[slot=input]:bg-card`} />;',
        filename: 'a.tsx',
        errors: [
          { messageId: 'restyle', data: { slot: 'checkbox' } },
          { messageId: 'restyle', data: { slot: 'input' } },
        ],
      },
      {
        code: 'const x = <Sheet contentClassName="[&_[data-slot=sheet-close]]:right-4" />;',
        filename: 'a.tsx',
        errors: [{ messageId: 'restyle', data: { slot: 'sheet-close' } }],
      },
      {
        code: "const card = clsx('*:data-[slot=card-header]:p-0');",
        filename: 'a.tsx',
        errors: [{ messageId: 'restyle', data: { slot: 'card-header' } }],
      },
    ],
  });
});

test('KIT_SLOTS holds every data-slot that @zukhruf/shadcn renders', async () => {
  const components = new URL(
    '../../../shadcn/src/components/',
    import.meta.url,
  );
  const rendered = new Set<string>();
  for await (const file of glob('*.tsx', { cwd: components })) {
    const source = await readFile(new URL(file, components), 'utf8');
    for (const [, slot] of source.matchAll(/data-slot="([^"]+)"/g)) {
      rendered.add(slot ?? '');
    }
  }
  assert.deepEqual(
    [...KIT_SLOTS],
    [...rendered].sort(),
    'Write the sorted list into kit-slots.ts after `nx run shadcn:sync`.',
  );
});
