// A package of a node_modules folder that the lockfile records, and that is
// not a link: a dependency from the registry, git or a tarball.
export interface ThirdPartyPackage {
  readonly version: string | undefined;
  // npm skips an optional package that does not fit the platform.
  readonly optional: boolean;
}

// The `packages` of an npm lockfile (lockfileVersion 2 or 3), keyed by the
// folder of each package, relative to the folder of the lockfile: "" for the
// root, `packages/a` for a workspace, `node_modules/x` for a dependency.
export class Lockfile {
  readonly #packages: readonly (readonly [string, unknown])[];

  private constructor(packages: readonly (readonly [string, unknown])[]) {
    this.#packages = packages;
  }

  static parse(text: string): Lockfile {
    const lockfile: unknown = JSON.parse(text);
    const packages =
      typeof lockfile === 'object' &&
      lockfile !== null &&
      'packages' in lockfile
        ? lockfile.packages
        : undefined;
    if (typeof packages !== 'object' || packages === null)
      throw new TypeError(
        'the lockfile has no "packages"; npm 7 or later writes it',
      );
    return new Lockfile(Object.entries(packages));
  }

  // The folders of the packages of the repo: the root, each workspace, and
  // each folder of the repo that a `file:` dependency links to. A key in a
  // node_modules folder is a dependency, and a key that starts with `..` is a
  // folder outside the repo.
  projects(): string[] {
    return this.#packages
      .map(([key]) => key)
      .filter((key) => !inNodeModules(key) && !key.startsWith('..'));
  }

  // The packages in a node_modules folder that are not links, by their key.
  thirdParty(): Map<string, ThirdPartyPackage> {
    const packages = new Map<string, ThirdPartyPackage>();
    for (const [key, value] of this.#thirdParty()) {
      const version = field(value, 'version');
      packages.set(key, {
        version: typeof version === 'string' ? version : undefined,
        optional: field(value, 'optional') === true,
      });
    }
    return packages;
  }

  // The folders that the links of the lockfile point to, relative to the
  // folder of the lockfile: the workspace packages, and each folder that a
  // `file:` dependency names.
  linkTargets(): string[] {
    const targets = new Set<string>();
    for (const [, value] of this.#packages) {
      const resolved = field(value, 'resolved');
      if (field(value, 'link') === true && typeof resolved === 'string')
        targets.add(resolved);
    }
    return [...targets];
  }

  // The names of the third-party packages that the lockfile marks with an
  // install script. The root and the workspace packages have the mark too,
  // but they are not third-party packages.
  withInstallScripts(): string[] {
    const names = new Set<string>();
    for (const [key, value] of this.#thirdParty())
      if (field(value, 'hasInstallScript') === true)
        names.add(
          key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length),
        );
    return [...names];
  }

  *#thirdParty(): Generator<readonly [string, unknown]> {
    for (const entry of this.#packages)
      if (inNodeModules(entry[0]) && field(entry[1], 'link') !== true)
        yield entry;
  }
}

function inNodeModules(key: string): boolean {
  return key.split('/').includes('node_modules');
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}
