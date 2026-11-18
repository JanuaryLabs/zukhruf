import type { Commit } from './commit.ts';
import { Lockfile, type ThirdPartyPackage } from './npm/lockfile.ts';
import { type Outcome, Step } from './step.ts';

// Stops a commit whose package-lock.json has a package with an install script
// that no key of `allowScripts` in the root package.json decides. npm checks
// the policy only for the packages that fit the machine that installs, so a
// package that fits only Linux passes an install on macOS and stops `npm ci`
// in CI. The lockfile lists the packages of every platform, so the step reads
// them all at once (ADR 0005).
export class InstallScriptsReviewed extends Step<Commit> {
  readonly name = 'install-scripts';

  async run(commit: Commit): Promise<Outcome> {
    if (!(await commit.touches(['package-lock.json', 'package.json'])))
      return this.skip('no package-lock.json or root package.json');
    const tree = await commit.tree();
    const text = await tree.read('package-lock.json');
    if (text === undefined) return this.skip('the commit has no lockfile');
    const manifest = await tree.read('package.json');
    const keys = manifest === undefined ? [] : allowScriptsKeys(manifest);
    const undecided = new Map<string, string[]>();
    for (const [key, entry] of Lockfile.parse(text).thirdParty()) {
      if (!entry.hasInstallScript || entry.inBundle || !entry.fromRegistry)
        continue;
      if (keys.some((policy) => names(policy, entry))) continue;
      const folders = undecided.get(entry.name) ?? [];
      folders.push(`    ${key}${fits(entry)}`);
      undecided.set(entry.name, folders);
    }
    if (undecided.size === 0)
      return this.pass('allowScripts decides each install script');
    return this.fail(
      [
        'package-lock.json has install scripts that allowScripts in package.json does not decide:',
        ...[...undecided].flatMap(([name, folders]) => [
          `  ${name}`,
          ...folders,
        ]),
        'npm ci stops at each one on a machine that it fits. Read each script, name the package in allowScripts of the root package.json with true or false, and commit again.',
      ].join('\n'),
    );
  }
}

// The keys of `allowScripts` in a package.json. A manifest that is not JSON
// has none; LockfileSync names it.
function allowScriptsKeys(manifest: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  const policy =
    typeof parsed === 'object' && parsed !== null && 'allowScripts' in parsed
      ? parsed.allowScripts
      : undefined;
  return typeof policy === 'object' && policy !== null
    ? Object.keys(policy)
    : [];
}

// Whether a key of `allowScripts` names a package, as npm matches a key of a
// registry package (arborist lib/script-allowed.js): the bare name, `name@*`,
// or the name with exact versions joined by `||`.
function names(key: string, entry: ThirdPartyPackage): boolean {
  const at = key.indexOf('@', 1);
  if (at === -1) return key === entry.name;
  if (key.slice(0, at) !== entry.name) return false;
  const spec = key.slice(at + 1).trim();
  if (spec === '' || spec === '*') return true;
  const { version } = entry;
  return (
    version !== undefined &&
    spec
      .split('||')
      .map((listed) => listed.trim())
      .includes(version)
  );
}

// The platform that a package fits, as the lockfile records it.
function fits(entry: ThirdPartyPackage): string {
  const parts = Object.entries(entry.platform)
    .filter(([, values]) => values.length > 0)
    .map(([kind, values]) => `${kind}: ${values.join(', ')}`);
  return parts.length === 0 ? '' : `  (${parts.join('; ')})`;
}
