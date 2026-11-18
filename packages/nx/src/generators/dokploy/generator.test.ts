import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  type NxJsonConfiguration,
  type Tree,
  readJson,
  writeJson,
} from '@nx/devkit';

import { TemporaryFiles } from '@zukhruf/fs';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import pairGenerator from '../pair/generator.ts';
import reactAppGenerator from '../react-app/generator.ts';
import dokployGenerator, { type DokployOptions } from './generator.ts';

const production = 'infra/src/environments/production';

/** A workspace with a node-app in apps/backend and, given `database`, a Prisma package there. */
async function workspace(database?: string): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  if (database !== undefined) {
    writeJson(tree, `${database}/package.json`, { name: '@acme/db' });
    tree.write(`${database}/Dockerfile.migration`, 'FROM node:lts-alpine\n');
  }
  return tree;
}

const read = (tree: Tree, path: string) => tree.read(path, 'utf-8') ?? '';

const hosts = {
  dns: { host: 'acme.example.com' },
  sslip: {},
} as const;

for (const [hostMode, hostOptions] of Object.entries(hosts)) {
  for (const postgres of [true, false]) {
    for (const registry of [true, false]) {
      test(`host ${hostMode}, postgres ${postgres ? 'on' : 'off'}, private registry ${registry ? 'on' : 'off'}`, async () => {
        const tree = await workspace(postgres ? 'packages/db' : undefined);
        const options: DokployOptions = {
          api: 'apps/backend',
          owner: 'Acme-Org',
          ...hostOptions,
          ...(postgres ? { database: 'packages/db' } : {}),
          ...(registry ? { registryUser: 'octocat' } : {}),
        };

        await dokployGenerator(tree, options);

        const versions = read(tree, `${production}/versions.tf`);
        const lock = read(tree, `${production}/.terraform.lock.hcl`);
        assert.match(
          versions,
          /source {2}= "registry\.terraform\.io\/ahmedali6\/dokploy"/,
        );
        assert.match(versions, /source {2}= "hetznercloud\/hcloud"/);
        assert.equal(/hashicorp\/random/.test(versions), postgres);
        assert.equal(/hashicorp\/random/.test(lock), postgres);
        assert.match(
          lock,
          /provider "registry\.terraform\.io\/ahmedali6\/dokploy"/,
        );
        assert.match(
          lock,
          /provider "registry\.opentofu\.org\/hetznercloud\/hcloud"/,
        );

        const compose = read(tree, 'infra/compose.dokploy.yml');
        assert.match(compose, /image: ghcr\.io\/acme-org\/acme-backend:latest/);
        assert.equal(/^ {2}postgres:$/m.test(compose), postgres);
        assert.equal(
          /image: ghcr\.io\/acme-org\/acme-migrate:latest/.test(compose),
          postgres,
        );
        assert.equal(
          /condition: service_completed_successfully/.test(compose),
          postgres,
        );
        assert.match(compose, /Host\(`\$\{PUBLIC_HOST\}`\)/);

        const main = read(tree, `${production}/main.tf`);
        assert.match(main, /PUBLIC_HOST=\$\{local\.host\}/);
        assert.equal(
          /CONNECTION_STRING=postgresql:\/\/acme:/.test(main),
          postgres,
        );
        assert.equal(
          /resource "random_password" "postgres"/.test(main),
          postgres,
        );
        assert.doesNotMatch(main, /terraform_data/);

        const dns = read(tree, `${production}/dns.tf`);
        const providers = read(tree, `${production}/providers.tf`);
        assert.match(
          dns,
          /data "hcloud_server" "dokploy" \{\n {2}name = "limerence-dokploy"/,
        );
        assert.equal(/hcloud_zone_rrset/.test(dns), hostMode === 'dns');
        assert.match(
          providers,
          hostMode === 'dns'
            ? /host {9}= "acme\.example\.com"/
            : /host {9}= "acme\.\$\{data\.hcloud_server\.dokploy\.ipv4_address\}\.sslip\.io"/,
        );

        assert.equal(tree.exists(`${production}/registry.tf`), registry);
        if (registry) {
          // Dokploy's registry.create refuses a URL with a scheme.
          assert.match(
            read(tree, `${production}/registry.tf`),
            /registry_url {2}= "ghcr\.io"/,
          );
        }
        const variables = read(tree, `${production}/variables.tf`);
        assert.equal(/variable "ghcr_pull_token"/.test(variables), registry);
        const envExample = read(tree, 'infra/.env.example');
        assert.match(
          envExample,
          /^TF_VAR_dokploy_api_key=\$\{DOKPLOY_API_KEY\}$/m,
        );
        assert.equal(
          /^TF_VAR_ghcr_pull_token=\$\{GHCR_PULL_TOKEN\}$/m.test(envExample),
          registry,
        );

        const deploy = read(tree, '.github/workflows/deploy.yml');
        assert.match(
          deploy,
          /- image: acme-backend\n {12}dockerfile: apps\/backend\/Dockerfile/,
        );
        assert.equal(
          /- image: acme-migrate\n {12}dockerfile: packages\/db\/Dockerfile\.migration/.test(
            deploy,
          ),
          postgres,
        );
        assert.equal(
          /"TF_VAR_ghcr_pull_token": \$\{\{ toJSON\(secrets\.GHCR_PULL_TOKEN\) \}\}/.test(
            deploy,
          ),
          registry,
        );
      });
    }
  }
}

test('the deploy workflow is built from the actions of zukhruf and checks the sha only after a new image', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  const deploy = read(tree, '.github/workflows/deploy.yml');
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/workflows\/tofu-apply\.yml@main\n/,
  );
  assert.match(
    deploy,
    /stack: infra\n {6}environment: production\n {6}state_file: infra\/src\/terraform\.tfstate/,
  );
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/dokploy-deploy@main/,
  );
  assert.match(
    deploy,
    /compose-id: \$\{\{ fromJSON\(needs\.infra\.outputs\.outputs\)\.compose_id \}\}/,
  );
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/wait-for-health@main/,
  );
  assert.match(
    deploy,
    /url: https:\/\/\$\{\{ fromJSON\(needs\.infra\.outputs\.outputs\)\.host \}\}\/api\/healthz/,
  );
  assert.match(
    deploy,
    /sha: \$\{\{ case\(needs\.promote\.result == 'success', env\.SHA, ''\) \}\}/,
  );
  assert.match(
    deploy,
    /needs\.promote\.result == 'success' \|\| needs\.infra\.outputs\.changed == 'true' \|\| needs\.gate\.outputs\.infra == 'true'/,
  );
  assert.match(
    deploy,
    /concurrency:\n {2}group: deploy\n {2}cancel-in-progress: false\n {2}queue: max/,
  );
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/tested-commit@main/,
  );
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/affected-range@main\n {8}with:\n {10}workflow-id: deploy\.yml\n {10}last-successful-event: workflow_run/,
  );
  assert.match(
    deploy,
    /id: infra\n {8}uses: JanuaryLabs\/zukhruf\/\.github\/actions\/affected-projects@main\n {8}with:\n {10}projects: '@acme\/infra'/,
  );
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/ghcr-image@main\n {8}with:\n {10}image: \$\{\{ matrix\.image \}\}\n {10}dockerfile: \$\{\{ matrix\.dockerfile \}\}\n {10}sha: \$\{\{ env\.SHA \}\}\n {10}build-args: BUILD_SHA=\$\{\{ env\.SHA \}\}/,
  );
  assert.match(
    deploy,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/ghcr-promote@main\n {8}with:\n {10}image: \$\{\{ matrix\.image \}\}\n {10}from: \$\{\{ env\.SHA \}\}/,
  );
  assert.match(
    read(tree, `${production}/outputs.tf`),
    /output "compose_id"[\s\S]*output "host"/,
  );
});

test('a new image follows a change of each project that the Dockerfile builds and of the Prisma package', async () => {
  const tree = await workspace('packages/db');
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    database: 'packages/db',
  });

  assert.match(
    read(tree, '.github/workflows/deploy.yml'),
    /id: image\n {8}uses: JanuaryLabs\/zukhruf\/\.github\/actions\/affected-projects@main\n {8}with:\n {10}projects: '@acme\/backend @acme\/web @acme\/db'/,
  );
});

test('Postgres 18 keeps its data under /var/lib/postgresql and answers its health check on 127.0.0.1', async () => {
  const tree = await workspace('packages/db');

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    name: 'my-app',
    database: 'packages/db',
  });

  const compose = read(tree, 'infra/compose.dokploy.yml');
  assert.match(compose, /image: postgres:18-alpine/);
  assert.match(compose, /- pgdata:\/var\/lib\/postgresql\n/);
  assert.doesNotMatch(compose, /PGDATA:/);
  assert.match(compose, /pg_isready -h 127\.0\.0\.1 -U my_app -d my_app/);
  assert.match(compose, /POSTGRES_USER: my_app/);
  assert.match(
    compose,
    /networks:\n {6}default: \{\}\n {6}dokploy-network: \{\}/,
  );
  assert.match(
    read(tree, `${production}/main.tf`),
    /CONNECTION_STRING=postgresql:\/\/my_app:\$\{random_password\.postgres\.result\}@postgres:5432\/my_app/,
  );
});

test('each $ of the raw compose is a ${VAR} of the Dokploy environment or an escaped $$', async () => {
  const tree = await workspace('packages/db');

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    database: 'packages/db',
    registryUser: 'octocat',
  });

  const compose = read(tree, 'infra/compose.dokploy.yml');
  const unescaped = compose.replaceAll('$$', '');
  const placeholders = [...unescaped.matchAll(/\$(\{[A-Z_]+\})?/g)];
  assert.ok(placeholders.length > 0);
  for (const [match, name] of placeholders) {
    assert.ok(name !== undefined, `a bare ${match} in the compose`);
  }
  const env = read(tree, `${production}/main.tf`);
  for (const name of new Set(compose.match(/(?<=\$\{)[A-Z_]+(?=\})/g))) {
    assert.match(
      env,
      new RegExp(`^ {4}${name}=`, 'm'),
      `${name} is not in the env`,
    );
  }
});

test('each variable of the stack refuses an empty value', async () => {
  const tree = await workspace('packages/db');

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    database: 'packages/db',
    registryUser: 'octocat',
  });

  const files = ['variables.tf', 'encryption.tf'].map((file) =>
    read(tree, `${production}/${file}`),
  );
  const variables = files.flatMap((file) => [
    ...file.matchAll(/^variable "([^"]+)" \{\n([\s\S]*?)^\}/gm),
  ]);
  assert.deepEqual(variables.map(([, name]) => name).toSorted(), [
    'dokploy_api_key',
    'ghcr_pull_token',
    'tf_encryption_passphrase',
  ]);
  for (const [, name, body] of variables) {
    assert.match(
      body ?? '',
      new RegExp(`condition {5}= length\\(var\\.${name}\\) > 0`),
      `${name} has no non-empty validation`,
    );
  }
});

test('the GHCR owner is lowercase', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'Phi-Science' });

  assert.match(
    read(tree, 'infra/compose.dokploy.yml'),
    /image: ghcr\.io\/phi-science\/acme-backend:latest/,
  );
});

test('a host and a zone give the record name in the zone', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    host: 'app.eu.example.com',
    zone: 'example.com',
  });

  const dns = read(tree, `${production}/dns.tf`);
  assert.match(dns, /zone = "example\.com"\n {2}name = "app\.eu"/);
});

test('the dokploy host, the server and the name are options', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    name: 'shop',
    dokployHost: 'https://panel.example.com/api',
    server: 'box-1',
  });

  assert.match(
    read(tree, `${production}/providers.tf`),
    /dokploy_host = "https:\/\/panel\.example\.com\/api"/,
  );
  assert.match(read(tree, `${production}/dns.tf`), /name = "box-1"/);
  assert.match(
    read(tree, `${production}/main.tf`),
    /resource "dokploy_project" "shop" \{\n {2}name = "shop"/,
  );
  assert.match(
    read(tree, 'infra/compose.dokploy.yml'),
    /image: ghcr\.io\/acme\/shop-backend:latest[\s\S]*traefik\.http\.routers\.shop-websecure/,
  );
  assert.match(
    read(tree, `${production}/encryption.tf`),
    /key_provider "pbkdf2" "shop"/,
  );
});

test('the infra project gets its targets from @zukhruf/nx/opentofu, listed after @zukhruf/nx/format', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  const { plugins } = readJson<NxJsonConfiguration>(tree, 'nx.json');
  const names = (plugins ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.plugin,
  );
  assert.equal(
    names.indexOf('@zukhruf/nx/opentofu'),
    names.indexOf('@zukhruf/nx/format') + 1,
  );
  assert.equal(readJson(tree, 'infra/project.json').name, '@acme/infra');
  assert.match(
    read(tree, '.prettierignore'),
    /^\.terraform\ntfplan\ninfra\/src\/terraform\.tfstate$/m,
  );
  assert.match(
    read(tree, `${production}/backend.tf`),
    /path = "\.\.\/\.\.\/terraform\.tfstate"/,
  );
});

test('a second run changes nothing', async () => {
  const tree = await workspace('packages/db');
  const options: DokployOptions = {
    api: 'apps/backend',
    owner: 'acme',
    database: 'packages/db',
    registryUser: 'octocat',
  };
  await dokployGenerator(tree, options);
  const firstRun = changes(tree);

  await dokployGenerator(tree, options);

  assert.deepEqual(changes(tree), firstRun);
});

test('a run without the registry removes the registry of an earlier run', async () => {
  const tree = await workspace();
  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    registryUser: 'octocat',
  });

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.ok(!tree.exists(`${production}/registry.tf`));
});

test('a CI workflow that is there stays', async () => {
  const tree = await workspace();
  tree.write('.github/workflows/ci.yml', 'name: CI\n');

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.equal(read(tree, '.github/workflows/ci.yml'), 'name: CI\n');
});

test('a deploy workflow that is there stays', async () => {
  const tree = await workspace();
  tree.write('.github/workflows/deploy.yml', 'name: Deploy\n');

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.equal(read(tree, '.github/workflows/deploy.yml'), 'name: Deploy\n');
});

test('a new zizmor config allows tags and the deploy that CI starts', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  const zizmor = read(tree, '.github/zizmor.yml');
  assert.match(
    zizmor,
    /unpinned-uses:\n {4}config:\n {6}policies:\n(?: {8}#.*\n)* {8}'\*': ref-pin/,
  );
  assert.match(
    zizmor,
    /dangerous-triggers:\n {4}ignore:\n(?: {6}#.*\n)* {6}- deploy\.yml/,
  );
});

test('a zizmor config that is there stays', async () => {
  const tree = await workspace();
  tree.write('.github/zizmor.yml', 'rules: {}\n');

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.equal(read(tree, '.github/zizmor.yml'), 'rules: {}\n');
});

test('a new CI workflow checks the infra project with OpenTofu and audits the workflows', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  const ci = read(tree, '.github/workflows/ci.yml');
  assert.match(ci, /^name: CI$/m);
  assert.match(
    ci,
    /id: tofu\n {8}background: true\n {8}uses: opentofu\/setup-opentofu@v2/,
  );
  assert.match(
    ci,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/setup-workspace@main/,
  );
  assert.match(
    ci,
    /uses: JanuaryLabs\/zukhruf\/\.github\/actions\/affected-range@main/,
  );
  assert.match(ci, /uses: zizmorcore\/zizmor-action@v0\.8\.1/);
  assert.match(
    ci,
    /wait: tofu\n[\s\S]*npx nx affected -t lint typecheck test build\n/,
  );
});

test('an api that is not a node-app stops the generator', async () => {
  const tree = generatorTree();
  writeJson(tree, 'nx.json', {});
  writeJson(tree, 'apps/backend/package.json', { name: '@acme/backend' });

  await assert.rejects(
    dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' }),
    /apps\/backend has no Dockerfile, so it is not a node-app\. Run @zukhruf\/nx:node-app apps\/backend first\./,
  );
});

test('a database that is not a Prisma package stops the generator', async () => {
  const tree = await workspace();
  writeJson(tree, 'packages/db/package.json', { name: '@acme/db' });

  await assert.rejects(
    dokployGenerator(tree, {
      api: 'apps/backend',
      owner: 'acme',
      database: 'packages/db',
    }),
    /packages\/db has no Dockerfile\.migration, so it is not a Prisma package\./,
  );
});

// The consumer's @zukhruf/nx/opentofu format:check runs tofu fmt -check, so a
// .tf file that tofu fmt would rewrite fails a freshly generated repo. The
// content assertions above cannot see HCL alignment (#4657).
const tofuOnPath =
  spawnSync('tofu', ['version'], { stdio: 'ignore' }).status === 0;

test(
  'tofu fmt would change no .tf file the generator writes',
  { skip: tofuOnPath ? false : 'tofu is not on PATH' },
  async () => {
    for (const [hostMode, hostOptions] of Object.entries(hosts)) {
      for (const postgres of [true, false]) {
        for (const registry of [true, false]) {
          const tree = await workspace(postgres ? 'packages/db' : undefined);
          await dokployGenerator(tree, {
            api: 'apps/backend',
            owner: 'Acme-Org',
            ...hostOptions,
            ...(postgres ? { database: 'packages/db' } : {}),
            ...(registry ? { registryUser: 'octocat' } : {}),
          });
          await using folder = await new TemporaryFiles().directory(
            'zukhruf-nx-',
          );
          for (const change of tree.listChanges()) {
            if (change.type === 'DELETE' || !change.path.endsWith('.tf')) {
              continue;
            }
            const path = join(folder.path, change.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, change.content ?? '');
          }

          const fmt = spawnSync(
            'tofu',
            ['fmt', '-check', '-diff', '-recursive', folder.path],
            { encoding: 'utf8' },
          );

          assert.equal(
            fmt.status,
            0,
            `host ${hostMode}, postgres ${postgres}, registry ${registry}: tofu fmt would rewrite\n${fmt.stdout}${fmt.stderr}`,
          );
        }
      }
    }
  },
);

test('a zone without a host, or a host outside its zone, stops the generator', async () => {
  const tree = await workspace();

  await assert.rejects(
    dokployGenerator(tree, {
      api: 'apps/backend',
      owner: 'acme',
      zone: 'example.com',
    }),
    /The zone "example\.com" needs a host in it\./,
  );
  await assert.rejects(
    dokployGenerator(tree, {
      api: 'apps/backend',
      owner: 'acme',
      host: 'app.example.org',
      zone: 'example.com',
    }),
    /The host "app\.example\.org" is not a name in the zone "example\.com"\./,
  );
});
