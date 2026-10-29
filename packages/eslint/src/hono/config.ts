import { type Concept, enable } from '../concept.ts';
import { TESTS, TEST_SUPPORT, TYPESCRIPT } from '../files.ts';
import noCatchAroundNext from './no-catch-around-next.ts';
import noHttpExceptionFactory from './no-http-exception-factory.ts';
import noUntypedEmptyJson from './no-untyped-empty-json.ts';

const rules = {
  'no-untyped-empty-json': noUntypedEmptyJson,
  'no-http-exception-factory': noHttpExceptionFactory,
  'no-catch-around-next': noCatchAroundNext,
};

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
