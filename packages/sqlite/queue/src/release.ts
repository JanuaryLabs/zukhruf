import manifest from '../package.json' with { type: 'json' };

// A release of this package, by the version in its package.json. Fixed
// versioning raises the version at each release, so the versions order the
// releases and no person keeps a schema number (docs/adr/0006).
export class Release {
  // ../package.json is the package root from src/ and from dist/ alike. A
  // JSON import, not a read of a file beside the module: a bundler copies the
  // manifest into the bundle, where no package.json is beside it (#4516).
  static readonly current = new Release(manifest.version);

  readonly version: string;
  readonly #parts: readonly [number, number, number];

  constructor(version: string) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (match === null)
      throw new Error(
        `A release version is MAJOR.MINOR.PATCH, not ${version}.`,
      );
    this.version = version;
    this.#parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  isAfter(other: Release): boolean {
    const [major, minor, patch] = this.#parts;
    const [theirMajor, theirMinor, theirPatch] = other.#parts;
    if (major !== theirMajor) return major > theirMajor;
    if (minor !== theirMinor) return minor > theirMinor;
    return patch > theirPatch;
  }
}
