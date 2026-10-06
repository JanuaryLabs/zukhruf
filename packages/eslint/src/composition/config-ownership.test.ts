import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Linter } from 'eslint';

import hermes from '../hermes/plugin.ts';
import island from '../island/plugin.ts';
import manifest from '../manifest/plugin.ts';
import zukhruf from '../plugin.ts';

// Rules whose options are one list a repo fills with its own entries. Flat
// config keeps one options array per key, so a package that set them would be
// replaced by the repo, or would replace the repo's entries.
const REPO_OWNED = [
  'no-restricted-syntax',
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
];

const plugins = { zukhruf, island, manifest, hermes };

function configsOf(plugin: { configs: Record<string, Linter.Config[]> }) {
  return Object.entries(plugin.configs).flatMap(([name, configs]) =>
    configs.map((config) => ({ name, config })),
  );
}

const shipped = Object.values(plugins).flatMap(configsOf);

test('no shipped config sets a rule that a repo owns', () => {
  const offenders = shipped.flatMap(({ name, config }) =>
    Object.keys(config.rules ?? {})
      .filter((rule) => REPO_OWNED.includes(rule))
      .map((rule) => `${name}: ${rule}`),
  );
  assert.deepEqual(offenders, []);
});

test('every shipped glob starts with ** so it matches from any folder', () => {
  const offenders = shipped.flatMap(({ name, config }) =>
    [...(config.files ?? []).flat(), ...(config.ignores ?? [])]
      .filter((glob) => typeof glob !== 'string' || !glob.startsWith('**'))
      .map((glob) => `${name}: ${String(glob)}`),
  );
  assert.deepEqual(offenders, []);
});

test('each package rule is turned on by exactly one config', () => {
  const owners = new Map<string, Set<string>>();
  for (const { name, config } of shipped) {
    for (const rule of Object.keys(config.rules ?? {})) {
      if (!Object.keys(plugins).some((key) => rule.startsWith(`${key}/`))) {
        continue;
      }
      owners.set(rule, (owners.get(rule) ?? new Set()).add(name));
    }
  }
  const declared = Object.entries(plugins).flatMap(([key, plugin]) =>
    Object.keys(plugin.rules).map((rule) => `${key}/${rule}`),
  );

  assert.deepEqual(
    declared.filter((rule) => owners.get(rule)?.size !== 1),
    [],
    'Every rule needs one config that turns it on, and only one',
  );
});
