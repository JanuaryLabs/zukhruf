import nx from '@nx/eslint-plugin';
import { defineConfig } from 'eslint/config';

import zukhruf from './packages/eslint/src/index.ts';
import island, {
  islandConstraint,
  manifest,
  moduleBoundaries,
} from './packages/eslint/src/nx.ts';

// The workspace lints with @zukhruf/eslint's source, which Node runs with its
// types stripped: Nx loads this file to build the project graph before
// anything is built, and a rule edit applies on the next lint. Consumers
// install the built package (packages/eslint/docs/adr/0003).
export default defineConfig(
  nx.configs['flat/base'],
  {
    plugins: { zukhruf, island, manifest },
    extends: [
      'zukhruf/base',
      'zukhruf/tests',
      'zukhruf/hono',
      'zukhruf/diagnostics',
      'zukhruf/nx-project-json',
      'island/recommended',
      'manifest/recommended',
    ],
    settings: { island: { libraries: ['packages/**/*.ts'] } },
  },
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        moduleBoundaries({ depConstraints: [islandConstraint([])] }),
      ],
    },
  },
);
