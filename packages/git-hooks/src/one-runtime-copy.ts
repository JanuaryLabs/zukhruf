import type { Commit } from './commit.ts';
import { Lockfile } from './npm/lockfile.ts';
import { type Outcome, Step } from './step.ts';

export interface OneRuntimeCopyOptions {
  // The runtime packages that must have one folder each. Replaces the
  // default list.
  readonly packages?: readonly string[];
  // A folder of the lockfile that may hold a second copy, such as
  // `node_modules/@expo/cli/node_modules/zod`, with the reason.
  readonly allowed?: Readonly<Record<string, string>>;
}

// Stops a commit whose package-lock.json installs a runtime package in more
// than one folder. Each folder is its own module: two copies of react fail
// with "Invalid hook call", and two copies of zod both land in a bundle. The
// lockfile lists each folder that `npm ci` installs, so the step reads it and
// runs no npm (ADR 0005).
export class OneRuntimeCopy extends Step<Commit> {
  readonly name = 'runtime-copies';
  readonly #packages: readonly string[];
  readonly #allowed: Readonly<Record<string, string>>;

  constructor({
    packages = ['react', 'react-dom', 'zod'],
    allowed = {},
  }: OneRuntimeCopyOptions = {}) {
    super();
    this.#packages = packages;
    this.#allowed = allowed;
  }

  async run(commit: Commit): Promise<Outcome> {
    if (!(await commit.touches(['package-lock.json'])))
      return this.skip('no package-lock.json');
    const text = await (await commit.tree()).read('package-lock.json');
    if (text === undefined) return this.skip('the commit has no lockfile');
    const thirdParty = Lockfile.parse(text).thirdParty();
    const problems: string[] = [];
    for (const runtime of this.#packages) {
      const folders = [...thirdParty].filter(
        ([, entry]) => entry.folder === runtime,
      );
      const counted = folders.filter(
        ([key]) => !Object.hasOwn(this.#allowed, key),
      );
      if (counted.length > 1)
        problems.push(
          `${runtime} has ${counted.length} copies:`,
          ...counted.map(
            ([key, { version }]) =>
              `    ${version === undefined ? key : `${key}  ${version}`}`,
          ),
        );
    }
    for (const key of Object.keys(this.#allowed))
      if (!thirdParty.has(key))
        problems.push(
          `${key} is allowed, but package-lock.json no longer has it: remove it from allowed`,
        );
    if (problems.length === 0)
      return this.pass(`one copy of ${this.#packages.join(', ')}`);
    return this.fail(
      [
        'package-lock.json installs a runtime package more than once:',
        ...problems.map((problem) => `  ${problem}`),
        'Declare the version that the repo runs in the root package.json, so npm hoists it, and run `npm install`. Name a copy of a tool that no bundle loads in allowed, with the reason.',
      ].join('\n'),
    );
  }
}
