import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { workspace as temporaryWorkspace } from '../testing/workspace.ts';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/opentofu'));
const formatEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/format'));

interface Target {
  executor: string;
  options: { command: string; cwd: string; env?: Record<string, string> };
  configurations?: Record<string, { cwd: string }>;
  cache?: boolean;
  inputs?: unknown[];
  dependsOn?: string[];
}

// A `tofu` on the PATH of the tasks that logs each call to `tofu.log` in the
// workspace root, with the folder it ran in and the variables the targets
// set; `plan -out tfplan` writes the plan, as OpenTofu does.
const fakeTofu = (root: string) => `#!/bin/sh
echo "$(basename "$(pwd)"): tofu $* passphrase=\${TF_VAR_tf_encryption_passphrase-} data=\${TF_DATA_DIR-}" >> "${root}/tofu.log"
if [ "$1" = version ]; then echo "OpenTofu v0.0.0"; fi
if [ "$1" = plan ]; then echo plan > tfplan; fi
`;

// Nx (and Prettier for the format plugin) linked from zukhruf, the fake
// `tofu`, and the plugin entries in `nx.json`.
async function workspace(
  signal: AbortSignal,
  files: Record<string, string>,
  plugins: (string | object)[] = [pluginEntry],
) {
  const probe = await temporaryWorkspace<Target>({
    files: {
      ...files,
      '.gitignore': 'node_modules\n.nx\n.terraform\ntfplan\n.env\ntofu.log\n',
    },
    plugins,
    links: ['nx', 'prettier'],
    packages: {},
    signal,
  });
  await probe.write('node_modules/.bin/tofu', fakeTofu(probe.path));
  await chmod(join(probe.path, 'node_modules/.bin/tofu'), 0o755);
  return {
    ...probe,
    log: async () => (await probe.read('tofu.log')).trim().split('\n'),
  };
}

const projectJson = (name: string) => `{ "name": "${name}" }\n`;
const config = 'output "name" {\n  value = "probe"\n}\n';
const guard =
  ': "${TF_ENCRYPTION_PASSPHRASE:?TF_ENCRYPTION_PASSPHRASE missing: set it in the environment or in the .env file of the project}" && TF_VAR_tf_encryption_passphrase="$TF_ENCRYPTION_PASSPHRASE"';

test('a project with an environment gets the OpenTofu targets, and no apply', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/src/environments/production/main.tf': config,
  });

  const targets = await probe.targets('infra');

  const inputs = [
    '{projectRoot}/src/**/*.tf',
    '{projectRoot}/src/**/*.hcl',
    { runtime: 'tofu version' },
  ];
  const production = {
    cwd: 'packages/infra/src/environments/production',
  };
  assert.partialDeepStrictEqual(targets, {
    format: {
      options: { command: 'tofu fmt -recursive', cwd: 'packages/infra/src' },
    },
    'format:check': {
      options: {
        command: 'tofu fmt -check -recursive',
        cwd: 'packages/infra/src',
      },
      cache: true,
      inputs,
    },
    typecheck: {
      options: {
        command:
          'tofu -chdir=environments/production init -backend=false -input=false -lockfile=readonly && tofu -chdir=environments/production validate',
        cwd: 'packages/infra/src',
        env: { TF_DATA_DIR: '.terraform/validate' },
      },
      cache: true,
      inputs,
    },
    init: {
      options: { command: `${guard} tofu init -input=false`, ...production },
      configurations: { production },
    },
    preview: {
      options: {
        command: `rm -f tfplan && ${guard} tofu plan -out tfplan`,
        ...production,
      },
      dependsOn: ['init'],
    },
    output: { options: { command: `${guard} tofu output`, ...production } },
  });
  assert.match(
    targets['show']?.options.command ?? '',
    /^node ".*check-plan-fresh\.js" "\.\.\/\.\.\/\.\." && .* tofu show tfplan$/,
  );
  assert.deepEqual(
    Object.keys(targets).filter((name) =>
      ['apply', 'plan', 'validate', 'refresh'].includes(name),
    ),
    [],
  );
});

test('only a *.tf file directly in src/environments/<name> of its own project root makes an environment', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/modules-only/project.json': projectJson('modules-only'),
    'packages/modules-only/src/modules/network/main.tf': config,
    'packages/deep/project.json': projectJson('deep'),
    'packages/deep/src/environments/production/nested/main.tf': config,
    'packages/app/project.json': projectJson('app'),
    'packages/app/stack/project.json': projectJson('stack'),
    'packages/app/stack/src/environments/production/main.tf': config,
  });

  const listed = await probe.nx('show', 'projects', '--withTarget', 'preview');

  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.stdout.trim(), 'stack');
});

test('each environment is a configuration, production is the default, and typecheck validates each one', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/src/environments/staging/main.tf': config,
    'packages/infra/src/environments/production/main.tf': config,
    'packages/other/project.json': projectJson('other'),
    'packages/other/src/environments/qa/main.tf': config,
    'packages/other/src/environments/dev/main.tf': config,
  });

  const [infra, other] = await Promise.all(
    ['infra', 'other'].map(probe.targets),
  );

  assert.deepEqual(infra?.['init']?.configurations, {
    production: { cwd: 'packages/infra/src/environments/production' },
    staging: { cwd: 'packages/infra/src/environments/staging' },
  });
  assert.equal(
    infra?.['init']?.options.cwd,
    'packages/infra/src/environments/production',
  );
  assert.equal(
    other?.['init']?.options.cwd,
    'packages/other/src/environments/dev',
  );
  assert.equal(
    infra?.['typecheck']?.options.command,
    [
      'tofu -chdir=environments/production init -backend=false -input=false -lockfile=readonly && tofu -chdir=environments/production validate',
      'tofu -chdir=environments/staging init -backend=false -input=false -lockfile=readonly && tofu -chdir=environments/staging validate',
    ].join(' && '),
  );
});

test('preview -c staging runs init and plan in staging with the passphrase of the project .env', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/.env': 'TF_ENCRYPTION_PASSPHRASE=from-dotenv\n',
    'packages/infra/src/environments/staging/main.tf': config,
    'packages/infra/src/environments/production/main.tf': config,
  });

  const run = await probe.nx('run', 'infra:preview', '-c', 'staging');

  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(await probe.log(), [
    'staging: tofu init -input=false passphrase=from-dotenv data=',
    'staging: tofu plan -out tfplan passphrase=from-dotenv data=',
  ]);
});

test('a target that reads the state stops before tofu when the passphrase is missing', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/src/environments/production/main.tf': config,
    'tofu.log': '',
  });

  const run = await probe.nx('run', 'infra:output');

  assert.notEqual(run.exitCode, 0);
  assert.match(run.output, /TF_ENCRYPTION_PASSPHRASE missing/);
  assert.equal(await probe.read('tofu.log'), '');
});

test('arguments after -- go to tofu output', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/.env': 'TF_ENCRYPTION_PASSPHRASE=secret\n',
    'packages/infra/src/environments/production/main.tf': config,
  });

  const run = await probe.nx('run', 'infra:output', '--', '-raw', 'name');

  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(await probe.log(), [
    'production: tofu output -raw name passphrase=secret data=',
  ]);
});

test('typecheck needs no secret, keeps its data folder apart, and replays from the cache', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/src/environments/production/main.tf': config,
  });

  const first = await probe.nx('run', 'infra:typecheck');
  const second = await probe.nx('run', 'infra:typecheck');

  assert.equal(first.exitCode, 0, first.output);
  assert.equal(second.exitCode, 0, second.output);
  assert.match(second.output, /Cache: +1\/1 hit/);
  // `tofu version` runs for the hash of each run; `init` and `validate` run
  // one time.
  assert.deepEqual(
    (await probe.log()).filter((line) => !line.includes('tofu version')),
    [
      'src: tofu -chdir=environments/production init -backend=false -input=false -lockfile=readonly passphrase= data=.terraform/validate',
      'src: tofu -chdir=environments/production validate passphrase= data=.terraform/validate',
    ],
  );
});

test('show stops with no plan, shows a fresh plan, and stops when a file of the project changed after preview', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/infra/project.json': projectJson('infra'),
    'packages/infra/.env': 'TF_ENCRYPTION_PASSPHRASE=secret\n',
    'packages/infra/compose.dokploy.yml': 'services: {}\n',
    'packages/infra/src/environments/production/main.tf': config,
    'packages/infra/src/environments/staging/main.tf': config,
  });
  execFileSync('git', ['init', '--quiet'], { cwd: probe.path });
  const production = join(
    probe.path,
    'packages/infra/src/environments/production',
  );
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

  const missing = await probe.nx('run', 'infra:show');
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.output, /has no tfplan\. Run the preview target/);

  await writeFile(join(production, 'tfplan'), 'plan\n');
  for (const file of [
    'packages/infra/project.json',
    'packages/infra/compose.dokploy.yml',
    'packages/infra/src/environments/production/main.tf',
    'packages/infra/src/environments/staging/main.tf',
  ]) {
    await utimes(join(probe.path, file), at(0), at(0));
  }
  await utimes(join(production, 'tfplan'), at(10), at(10));
  // Ignored by Git, so newer files here do not make the plan stale.
  await mkdir(join(production, '.terraform'));
  await writeFile(join(production, '.terraform/modules.json'), '{}\n');
  await writeFile(
    join(probe.path, 'packages/infra/src/environments/staging/tfplan'),
    'plan\n',
  );
  const fresh = await probe.nx('run', 'infra:show');
  assert.equal(fresh.exitCode, 0, fresh.output);
  assert.deepEqual(await probe.log(), [
    'production: tofu show tfplan passphrase=secret data=',
  ]);

  await utimes(
    join(probe.path, 'packages/infra/compose.dokploy.yml'),
    at(20),
    at(20),
  );
  const stale = await probe.nx('run', 'infra:show');
  assert.notEqual(stale.exitCode, 0);
  assert.match(
    stale.output,
    /tfplan is stale: \.\.\/\.\.\/\.\.\/compose\.dokploy\.yml changed after preview wrote the plan/,
  );
});

test('after @zukhruf/nx/format, an OpenTofu project gets the tofu format targets and another project keeps Prettier', async (t) => {
  await using probe = await workspace(
    t.signal,
    {
      'packages/infra/project.json': projectJson('infra'),
      'packages/infra/src/environments/production/main.tf': config,
      'packages/web/project.json': projectJson('web'),
    },
    [formatEntry, pluginEntry],
  );

  const [infra, web] = await Promise.all(['infra', 'web'].map(probe.targets));

  assert.partialDeepStrictEqual(infra?.['format:check'], {
    options: {
      command: 'tofu fmt -check -recursive',
      cwd: 'packages/infra/src',
    },
    inputs: [
      '{projectRoot}/src/**/*.tf',
      '{projectRoot}/src/**/*.hcl',
      { runtime: 'tofu version' },
    ],
  });
  assert.equal(
    web?.['format:check']?.options.command,
    'prettier --check packages/web',
  );
});
