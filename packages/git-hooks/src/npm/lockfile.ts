// A package of a node_modules folder that the lockfile records, and that is
// not a link: a dependency from the registry, git or a tarball.
export interface ThirdPartyPackage {
  // The name of its folder, which `import` resolves.
  readonly folder: string;
  // The name of the package in the registry: the `name` of an alias entry,
  // else the name of its folder.
  readonly name: string;
  readonly version: string | undefined;
  // npm skips an optional package that does not fit the platform.
  readonly optional: boolean;
  // A package that another package bundles in its tarball. npm never runs
  // its install scripts.
  readonly inBundle: boolean;
  readonly hasInstallScript: boolean;
  // Whether npm reads it as a package of a registry: its `resolved` is a
  // registry tarball, or the lockfile has no `resolved`, as npm does
  // (arborist lib/install-scripts.js). A package from git or a tarball is not.
  readonly fromRegistry: boolean;
  // The `os`, `cpu` and `libc` that the package fits; empty for each one.
  readonly platform: Readonly<Record<'os' | 'cpu' | 'libc', readonly string[]>>;
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

  // The dependencies that npm recorded for one project, `""` for the root,
  // in each section of its package.json, as that package.json held them when
  // npm wrote the lockfile. Undefined when the lockfile has no such project.
  specs(project: string): DependencySpecs | undefined {
    const entry = this.#packages.find(([key]) => key === project)?.[1];
    if (entry === undefined) return undefined;
    return dependencySpecs(entry);
  }

  // The packages in a node_modules folder that are not links, by their key.
  thirdParty(): Map<string, ThirdPartyPackage> {
    const packages = new Map<string, ThirdPartyPackage>();
    for (const [key, value] of this.#thirdParty()) {
      const folder = key.slice(
        key.lastIndexOf('node_modules/') + 'node_modules/'.length,
      );
      const name = field(value, 'name');
      const version = field(value, 'version');
      const resolved = field(value, 'resolved');
      packages.set(key, {
        folder,
        name: typeof name === 'string' ? name : folder,
        version: typeof version === 'string' ? version : undefined,
        optional: field(value, 'optional') === true,
        inBundle: field(value, 'inBundle') === true,
        hasInstallScript: field(value, 'hasInstallScript') === true,
        fromRegistry:
          typeof resolved !== 'string' ||
          /^https?:\/\/[^/]+\/.+\/-\/[^/]+-\d/.test(resolved),
        platform: {
          os: strings(field(value, 'os')),
          cpu: strings(field(value, 'cpu')),
          libc: strings(field(value, 'libc')),
        },
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

// The sections of a package.json that name dependencies, as npm records
// them for a project in the lockfile.
export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

// The specs of each dependency section of a package.json or of a project
// entry of a lockfile: name to spec. A missing section has no names.
export type DependencySpecs = Readonly<
  Record<(typeof DEPENDENCY_SECTIONS)[number], ReadonlyMap<string, string>>
>;

export function dependencySpecs(manifest: unknown): DependencySpecs {
  const specs = (section: string): ReadonlyMap<string, string> => {
    const names = field(manifest, section);
    return new Map(
      typeof names === 'object' && names !== null
        ? Object.entries(names).flatMap(([name, spec]) =>
            typeof spec === 'string' ? [[name, spec] as const] : [],
          )
        : [],
    );
  };
  return {
    dependencies: specs('dependencies'),
    devDependencies: specs('devDependencies'),
    optionalDependencies: specs('optionalDependencies'),
    peerDependencies: specs('peerDependencies'),
  };
}

function inNodeModules(key: string): boolean {
  return key.split('/').includes('node_modules');
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string')
    : [];
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}
