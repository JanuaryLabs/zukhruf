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

export interface NoUnassignedImportOptions {
  /** More side-effect imports to allow, as globs of the import source. */
  allow?: string[];
}

// The side effects the monorepo standard defines: a stylesheet for the
// bundler, `env.ts` that parses the environment first, and `startup.ts` that
// connects the stores before the server serves.
const STANDARD_SIDE_EFFECTS = ['**/*.css', '**/env.ts', '**/startup.ts'];

/** Options for `import-x/no-unassigned-import`, with the standard's side-effect imports already allowed. */
export function noUnassignedImport({
  allow = [],
}: NoUnassignedImportOptions = {}) {
  return { allow: [...STANDARD_SIDE_EFFECTS, ...allow] };
}

/** typescript-eslint's name for a type or value by where it is declared: the TS lib, a package, or a file. */
export interface TypeOrValueSpecifier {
  from: 'file' | 'lib' | 'package';
  name: string | string[];
  package?: string;
  path?: string;
}

export interface NoFloatingPromisesOptions {
  allowForKnownSafeCalls?: TypeOrValueSpecifier[];
}

// node:test's test/it/describe/suite return a Promise the runner owns.
const NODE_TEST_CALLS: TypeOrValueSpecifier = {
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
