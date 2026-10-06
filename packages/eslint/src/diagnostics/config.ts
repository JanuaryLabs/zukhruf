import { type Concept, enable } from '../concept.ts';
import { SOURCE, TESTS } from '../files.ts';
import consistentEventName from './consistent-event-name.ts';
import noFabricatedFallback from './no-fabricated-fallback.ts';
import noHardcodedIdShape from './no-hardcoded-id-shape.ts';

const rules = {
  'no-fabricated-fallback': noFabricatedFallback,
  'no-hardcoded-id-shape': noHardcodedIdShape,
  'consistent-event-name': consistentEventName,
};

/** Code that reports what happened: fallbacks, id matching, log event names. */
export const diagnostics: Concept = {
  name: 'diagnostics',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/diagnostics',
      files: SOURCE,
      ignores: TESTS,
      plugins,
      rules: enable(rules),
    },
  ],
};
