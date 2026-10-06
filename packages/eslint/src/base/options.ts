// Re-declaring a third-party rule replaces every option the base config gave
// it: `'functional/no-let': ['error', { ignoreIdentifierPattern }]` drops
// `allowInFunctions`, and every `let` inside a function becomes an error.
// These factories return the complete options with the repo's entries
// appended, so extending a base rule never loses the base's own.

export interface NoLetOptions {
  /** Module-scope `let` names to allow, as regexes. */
  ignoreIdentifierPattern?: string[];
}

/** Options for `functional/no-let`: no mutable state at module scope; locals and loop counters stay legal. */
export function noLet({ ignoreIdentifierPattern = [] }: NoLetOptions = {}) {
  return { allowInFunctions: true, ignoreIdentifierPattern };
}

export interface SafeCall {
  from: 'file' | 'lib' | 'package';
  name: string | string[];
  package?: string;
  path?: string;
}

export interface NoFloatingPromisesOptions {
  allowForKnownSafeCalls?: SafeCall[];
}

// node:test's test/it/describe/suite return a Promise the runner owns.
const NODE_TEST_CALLS: SafeCall = {
  from: 'package',
  package: 'node:test',
  name: ['test', 'it', 'describe', 'suite'],
};

/** Options for `@typescript-eslint/no-floating-promises`, with node:test's calls already allowed. */
export function noFloatingPromises({
  allowForKnownSafeCalls = [],
}: NoFloatingPromisesOptions = {}) {
  return {
    allowForKnownSafeCalls: [NODE_TEST_CALLS, ...allowForKnownSafeCalls],
  };
}
