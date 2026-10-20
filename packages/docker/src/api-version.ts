import { UnsupportedEngineError } from './errors.ts';

/** From 1.44 on, a create of a network with a taken name fails, and networks.createOrGet() needs that. */
export const LOWEST_API_VERSION = '1.44';
/** The highest API version that the tests of the package run on. */
export const HIGHEST_API_VERSION = '1.56';

/** Compares the numbers of two versions, so that 1.9 is lower than 1.10. */
function compareApiVersions(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0] = right.split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor;
}

/** The lower of the engine's highest version and the package's highest version. */
export function negotiateApiVersion(
  host: string,
  engineVersion: string,
): string {
  if (
    !/^\d+\.\d+$/.test(engineVersion) ||
    compareApiVersions(engineVersion, LOWEST_API_VERSION) < 0
  ) {
    throw new UnsupportedEngineError(host, engineVersion, LOWEST_API_VERSION);
  }
  return compareApiVersions(engineVersion, HIGHEST_API_VERSION) < 0
    ? engineVersion
    : HIGHEST_API_VERSION;
}
