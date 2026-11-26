import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type NxJsonConfiguration,
  type Tree,
  readJson,
  writeJson,
} from '@nx/devkit';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import { lintManifests } from '../../testing/lint-manifests.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import pairGenerator from '../pair/generator.ts';
import prismaGenerator from '../prisma/generator.ts';
import reactAppGenerator from '../react-app/generator.ts';
import { stackModuleSource } from './files.ts';
import dokployGenerator, { type DokployOptions } from './generator.ts';

const production = 'infra/src/environments/production';
const stackModule = fileURLToPath(
  new URL('../../../opentofu/dokploy-stack', import.meta.url),
);

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

void test.each(Object.entries(hosts), ([hostMode, hostOptions]) =>
  test.each([true, false], (postgres) =>
    test.each([true, false], (registry) =>
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
        // The module requires random even without a database.
        assert.match(versions, /source {2}= "hashicorp\/random"/);
        assert.match(
          lock,
          /provider "registry\.opentofu\.org\/hashicorp\/random"/,
        );
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
        assert.match(
          compose,
          /^ {2}backend:\n(?: {4}.*\n)*? {4}env_file: \.env\n/m,
        );

        const main = read(tree, `${production}/main.tf`);
        assert.match(main, /^module "stack" \{$/m);
        assert.match(main, /PUBLIC_HOST {5}= local\.host/);
        // CORS and better-auth trust the public origin in production.
        assert.match(
          main,
          /^ {4}ALLOWED_ORIGINS = "https:\/\/\$\{local\.host\}"$/m,
        );
        assert.equal(
          /^ {2}database {5}= \{ role = "acme" \}$/m.test(main),
          postgres,
        );
        assert.equal(
          /^ {2}registry {5}= \{ username = "octocat", password = var\.ghcr_pull_token \}$/m.test(
            main,
          ),
          registry,
        );
        assert.doesNotMatch(main, /^resource /m);

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

        assert.ok(!tree.exists(`${production}/registry.tf`));
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
      }),
    ),
  ),
);

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

test('the deploy gate compares the tested commit with main as it is when the run starts', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.match(
    read(tree, '.github/workflows/deploy.yml'),
    /- name: Checkout main\n {8}uses: actions\/checkout@v7\n {8}with:\n {10}ref: main\n/,
  );
});

test('a deploy run that main moved past cancels itself, so it is never the base of the next deploy', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  const deploy = read(tree, '.github/workflows/deploy.yml');
  assert.match(
    deploy,
    /id: tested\n {8}uses: JanuaryLabs\/zukhruf\/\.github\/actions\/tested-commit@main\n\n(?: {6}#.*\n)* {6}- name: .*\n {8}if: steps\.tested\.outputs\.current == 'false'\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {10}RUN_ID: \$\{\{ github\.run_id \}\}\n {8}run: gh run cancel "\$RUN_ID"\n/,
  );
  assert.match(
    deploy,
    /\n {2}gate:\n(?: {4}.*\n)*? {4}permissions:\n {6}actions: write\n {6}contents: read\n/,
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
  assert.match(compose, /^ {6}CONNECTION_STRING: \$\{CONNECTION_STRING\}$/m);
  assert.match(
    read(tree, `${production}/main.tf`),
    /^ {2}database {5}= \{ role = "my_app" \}$/m,
  );
});

// The module refuses a plan whose compose names a key that the env file does
// not have; this catches the generator's compose before any host plans it.
test('each $ of the raw compose is a ${VAR} of the env of the module call, a key of the database, or an escaped $$', async () => {
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
  const env = /^ {2}env = \{\n([\s\S]*?)^ {2}\}/m.exec(
    read(tree, `${production}/main.tf`),
  )?.[1];
  const keys = new Set([
    ...(env ?? '').matchAll(/^ {4}([A-Z_]+) +=/gm).map(([, key]) => key),
    'POSTGRES_PASSWORD',
    'CONNECTION_STRING',
  ]);
  for (const name of new Set(compose.match(/(?<=\$\{)[A-Z_]+(?=\})/g))) {
    assert.ok(keys.has(name), `${name} is not a key of the env file`);
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
  assert.match(read(tree, `${production}/main.tf`), /^ {2}name {9}= "shop"$/m);
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

test('Nx ignores the state that the apply workflow commits, so the commit does not make the infra project affected', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.equal(read(tree, '.nxignore'), 'infra/src/terraform.tfstate\n');
});

test('an existing .nxignore keeps its lines, and a second run adds the state once', async () => {
  const tree = await workspace();
  tree.write('.nxignore', '# vendored\nvendor/**');
  const options: DokployOptions = { api: 'apps/backend', owner: 'acme' };

  await dokployGenerator(tree, options);
  await dokployGenerator(tree, options);

  assert.equal(
    read(tree, '.nxignore'),
    '# vendored\nvendor/**\ninfra/src/terraform.tfstate\n',
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

test('a first run writes main.tf as a call of the dokploy-stack module at ref=main, with the marker as the last line of env', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  assert.match(
    read(tree, `${production}/main.tf`),
    /^module "stack" \{\n {2}source = "git::https:\/\/github\.com\/JanuaryLabs\/zukhruf\.git\/\/packages\/nx\/opentofu\/dokploy-stack\?ref=main"\n[\s\S]*\n {2}env = \{\n {4}PUBLIC_HOST {5}= local\.host\n {4}ALLOWED_ORIGINS = "https:\/\/\$\{local\.host\}"\n {4}# Generators add env keys above this line\.\n {2}\}\n\}\n/m,
  );
  assert.match(
    read(tree, `${production}/outputs.tf`),
    /value {7}= module\.stack\.compose_id/,
  );
  assert.ok(!tree.exists(`${production}/moved.tf`));
});

test('a second run keeps each file of infra/ that the repo edited, and deletes none', async () => {
  const tree = await workspace();
  const options: DokployOptions = {
    api: 'apps/backend',
    owner: 'acme',
    registryUser: 'octocat',
  };
  await dokployGenerator(tree, options);
  const edited = {
    [`${production}/main.tf`]: 'module "stack" {}\n',
    [`${production}/variables.tf`]: 'variable "resend_api_key" {}\n',
    [`${production}/registry.tf`]: '# the repo kept a file of an older run\n',
    'infra/compose.dokploy.yml': 'services: {}\n',
    'infra/project.json': '{ "name": "@acme/delivery" }\n',
  };
  for (const [path, content] of Object.entries(edited)) {
    tree.write(path, content);
  }

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  for (const [path, content] of Object.entries(edited)) {
    assert.equal(read(tree, path), content, `${path} was rewritten`);
  }
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

void test.each(Object.entries(hosts), ([hostMode, hostOptions]) =>
  test.each([true, false], (postgres) =>
    test.each([true, false], (registry) =>
      test(
        `tofu fmt would change no .tf file the generator writes for host ${hostMode}, postgres ${postgres ? 'on' : 'off'}, private registry ${registry ? 'on' : 'off'}`,
        { skip: tofuOnPath ? false : 'tofu is not on PATH' },
        async () => {
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
        },
      ),
    ),
  ),
);

// The generated main.tf calls the module at ref=main; this points the call at
// the module of the checkout, so an input that the generator writes and the
// module does not have fails here, before a host's tofu init fetches main.
// -lockfile=readonly, as the typecheck target runs it, also proves that the
// written lock file has each provider that the module requires.
void test.each(Object.entries(hosts), ([hostMode, hostOptions]) =>
  test.each([true, false], (postgres) =>
    test.each([true, false], (registry) =>
      test(
        `the generated infra validates against the dokploy-stack module of the checkout for host ${hostMode}, postgres ${postgres ? 'on' : 'off'}, private registry ${registry ? 'on' : 'off'}`,
        { skip: tofuOnPath ? false : 'tofu is not on PATH' },
        async () => {
          await using folder = await new TemporaryFiles().directory(
            'zukhruf-nx-',
          );
          const pluginCache = join(folder.path, 'plugin-cache');
          await mkdir(pluginCache);
          const tree = await workspace(postgres ? 'packages/db' : undefined);
          await dokployGenerator(tree, {
            api: 'apps/backend',
            owner: 'Acme-Org',
            ...hostOptions,
            ...(postgres ? { database: 'packages/db' } : {}),
            ...(registry ? { registryUser: 'octocat' } : {}),
          });
          const root = join(folder.path, 'checkout');
          await cp(stackModule, join(root, 'dokploy-stack'), {
            recursive: true,
            filter: (source) => !source.includes('.terraform'),
          });
          for (const change of tree.listChanges()) {
            if (change.type === 'DELETE' || !change.path.startsWith('infra/')) {
              continue;
            }
            const path = join(root, change.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(
              path,
              (change.content?.toString() ?? '').replace(
                stackModuleSource,
                '../../../../dokploy-stack',
              ),
            );
          }
          const environment = join(root, production);

          for (const args of [
            ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
            ['validate', '-no-color'],
          ]) {
            const run = spawnSync('tofu', args, {
              cwd: environment,
              encoding: 'utf8',
              env: { ...process.env, TF_PLUGIN_CACHE_DIR: pluginCache },
            });

            assert.equal(
              run.status,
              0,
              `host ${hostMode}, postgres ${postgres}, registry ${registry}: tofu ${args.join(' ')}\n${run.stdout}${run.stderr}`,
            );
          }
        },
      ),
    ),
  ),
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

test('what dokploy writes lints clean under @zukhruf/eslint', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    database: 'packages/db',
  });

  assert.deepEqual(await lintManifests(tree), []);
});

test('the workflows run under production with the devDependencies installed, and the .env.example of infra sets NODE_ENV=production', async () => {
  const tree = await workspace();

  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });

  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy.yml',
  ]) {
    assert.match(
      read(tree, path),
      /^env:\n(?: {2}.*\n)*? {2}NODE_ENV: production\n/m,
      path,
    );
    // npm omits devDependencies under NODE_ENV=production (meddit 2399cf1
    // failed CI on it); npm_config_include=dev keeps them.
    assert.match(
      read(tree, path),
      /^env:\n(?: {2}.*\n)*? {2}npm_config_include: dev\n/m,
      path,
    );
  }
  assert.match(
    read(tree, 'infra/.env.example'),
    /^# .+\nNODE_ENV=production$/m,
  );
});
