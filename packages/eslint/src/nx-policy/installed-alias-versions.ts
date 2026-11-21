import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { Rule } from 'eslint';
import { satisfies } from 'semver';

import { type AstNode, isType } from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';

interface AliasMismatch {
  readonly packageName: string;
  readonly range: string;
  readonly node: AstNode;
}

/**
 * Nx's `dependency-checks`, with the version that an `npm:` alias installs.
 * Nx's project graph gives an aliased package its alias as its version, such as
 * `npm:@typescript/typescript6@6.0.2` in the TypeScript 7 setup of
 * nx.dev/docs/kb/typescript-7. Nx then reports every range of that package as
 * a version mismatch, and its fix writes the alias into the range
 * (@nx/eslint-plugin 24.0.6, dependency-checks.js:251-268). For such a report,
 * this reads the version of the package.json that Node resolves from the linted
 * manifest: a range that holds it is not reported, and a range that does not
 * is reported with that version, and its fix writes that version.
 */
export function withInstalledAliasVersions(
  rule: Rule.RuleModule,
): Rule.RuleModule {
  return {
    ...rule,
    create(context) {
      const report = (descriptor: Rule.ReportDescriptor): void => {
        const alias = aliasMismatch(descriptor);
        if (alias === undefined) {
          context.report(descriptor);
          return;
        }
        const installed = installedVersion(
          alias.packageName,
          context.physicalFilename,
        );
        if (satisfies(installed, alias.range, { includePrerelease: true }))
          return;
        context.report({
          ...descriptor,
          data: { ...descriptor.data, version: installed },
          fix: (fixer) =>
            fixer.replaceText(
              alias.node,
              `"${alias.packageName}": "${installed}"`,
            ),
        });
      };
      return rule.create(Object.create(context, { report: { value: report } }));
    },
  };
}

function aliasMismatch(
  descriptor: Rule.ReportDescriptor,
): AliasMismatch | undefined {
  if (
    !('messageId' in descriptor) ||
    descriptor.messageId !== 'versionMismatch'
  )
    return undefined;
  const { data } = descriptor;
  const packageName = data?.['packageName'];
  const version = data?.['version'];
  if (typeof packageName !== 'string' || typeof version !== 'string')
    return undefined;
  if (!version.startsWith('npm:') || !('node' in descriptor)) return undefined;
  const node: unknown = descriptor.node;
  if (!isType(node, 'JSONProperty')) return undefined;
  const value = node['value'];
  if (!isType(value, 'JSONLiteral') || typeof value['value'] !== 'string')
    return undefined;
  return { packageName, range: value['value'], node };
}

function installedVersion(packageName: string, manifest: string): string {
  const file = findPackageJSON(packageName, pathToFileURL(manifest));
  if (file === undefined)
    throw new Error(`Node found no package.json for ${packageName}.`);
  const installed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(installed) || typeof installed['version'] !== 'string')
    throw new Error(`${file} has no version.`);
  return installed['version'];
}
