import { plugin as shadcnLint } from '@shadcn/lint';
import type { Linter } from 'eslint';

import { JSX } from '../files.ts';
import zukhruf from '../plugin.ts';

// The kit's layout containers, where a host spaces its own content (#5017).
const LAYOUT_CONTAINERS = [
  'Field',
  'FieldGroup',
  'CardContent',
  'CardHeader',
  'CollapsibleContent',
  'SidebarHeader',
  'SidebarContent',
  'SidebarGroup',
  'SidebarMenu',
  'TabsContent',
  'DropdownMenuLabel',
  'InputOTPGroup',
];

/**
 * The strict rules for a host of @zukhruf/shadcn: the kit is used as
 * installed, and a look it lacks goes into the host's theme or stylesheet. A
 * host spreads it after the `shadcn` config once it has fixed its hits (ADR
 * 0011), so an update of the package breaks no host that has not opted in.
 */
const strict: Linter.Config[] = [
  // `settings.shadcn` tells @shadcn/lint that the kit is a package: its
  // components come from `@zukhruf/shadcn`, and the tokens of its stylesheets
  // count as the host's own.
  {
    name: 'zukhruf/shadcn-strict/plugins',
    plugins: { zukhruf, shadcn: shadcnLint },
    settings: {
      shadcn: {
        componentImports: ['^@zukhruf/shadcn$'],
        themeImports: ['^@zukhruf/shadcn/'],
      },
    },
  },
  {
    name: 'zukhruf/shadcn-strict',
    files: JSX,
    rules: {
      'zukhruf/no-data-slot-restyle': 'error',
      'shadcn/no-restyle': [
        'error',
        {
          allow: ['layout'],
          contracts: [
            {
              pattern: `^(${LAYOUT_CONTAINERS.join('|')})$`,
              allow: ['layout', 'spacing'],
            },
          ],
        },
      ],
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-unknown-classes': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/require-static-classes': 'error',
    },
  },
];

export default strict;
