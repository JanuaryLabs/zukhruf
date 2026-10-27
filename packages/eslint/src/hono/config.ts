import { type Concept, enable } from '../concept.ts';
import { TESTS, TEST_SUPPORT, TYPESCRIPT } from '../files.ts';
import noUntypedEmptyJson from './no-untyped-empty-json.ts';

const rules = { 'no-untyped-empty-json': noUntypedEmptyJson };

export const hono: Concept = {
  name: 'hono',
  rules,
  config: (plugins) => [
    { name: 'zukhruf/hono/plugins', plugins },
    {
      name: 'zukhruf/hono',
      files: TYPESCRIPT,
      ignores: [...TESTS, ...TEST_SUPPORT],
      rules: enable(rules),
    },
  ],
};
