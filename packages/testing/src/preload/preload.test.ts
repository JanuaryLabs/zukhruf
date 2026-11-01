import assert from 'node:assert/strict';
import { test } from 'node:test';

import spawn from 'nano-spawn';

import { notInstalled } from './index.ts';

/**
 * A package that is not installed anywhere. Its error in the same child is
 * what Node.js throws for a missing package, so a test compares the error of
 * a hidden package with it.
 */
const missing = 'no-such-package-of-the-preload-test';

/** What a load in the child gave: its error, or `'loaded'`. */
type Outcome = 'loaded' | { code: string; message: string };

/**
 * Runs `code` as an ES module in a child process with the preloads, and gives
 * the object that `code` prints. `outcome(load)` in `code` gives the outcome
 * of a load.
 */
async function child(
  preloads: string[],
  code: string,
): Promise<Record<string, Outcome>> {
  const { stdout } = await spawn(process.execPath, [
    ...preloads.flatMap((preload) => ['--import', preload]),
    '--input-type=module',
    '--eval',
    `
    const outcome = async (load) => {
      try {
        await load();
        return 'loaded';
      } catch (error) {
        return { code: error.code, message: error.message };
      }
    };
    ${code}
    `,
  ]);
  return JSON.parse(stdout);
}

test('an import of a hidden package fails as an import of a package that is not installed', async () => {
  const { hidden, absent } = await child(
    [notInstalled('msw')],
    `console.log(JSON.stringify({
      hidden: await outcome(() => import('msw')),
      absent: await outcome(() => import('${missing}')),
    }));`,
  );

  assert.ok(typeof absent === 'object');
  assert.equal(absent.code, 'ERR_MODULE_NOT_FOUND');
  assert.deepEqual(hidden, {
    code: 'ERR_MODULE_NOT_FOUND',
    message: absent.message.replace(`'${missing}'`, "'msw'"),
  });
});

test('an import of a subpath of a hidden package fails and names the package', async () => {
  const { hidden, absent } = await child(
    [notInstalled('msw')],
    `console.log(JSON.stringify({
      hidden: await outcome(() => import('msw/node')),
      absent: await outcome(() => import('${missing}/node')),
    }));`,
  );

  assert.ok(typeof absent === 'object');
  assert.equal(absent.code, 'ERR_MODULE_NOT_FOUND');
  assert.deepEqual(hidden, {
    code: 'ERR_MODULE_NOT_FOUND',
    message: absent.message.replace(`'${missing}'`, "'msw'"),
  });
});

test('a require of a hidden package fails as a require of a module that is not installed', async () => {
  // The first line only: Node.js adds a require stack, which a hook cannot know.
  const { stdout } = await spawn(process.execPath, [
    '--import',
    notInstalled('msw'),
    '--input-type=commonjs',
    '--eval',
    `
    const outcome = (load) => {
      try {
        load();
        return 'loaded';
      } catch (error) {
        return { code: error.code, line: error.message.split('\\n')[0] };
      }
    };
    console.log(JSON.stringify({
      hidden: outcome(() => require('msw/node')),
      absent: outcome(() => require('${missing}/node')),
    }));
    `,
  ]);
  const { hidden, absent } = JSON.parse(stdout);

  assert.equal(absent.code, 'MODULE_NOT_FOUND');
  assert.deepEqual(hidden, {
    code: 'MODULE_NOT_FOUND',
    line: absent.line.replace(`'${missing}/node'`, "'msw/node'"),
  });
});

test('a package whose name starts with a hidden name still loads', async () => {
  // pg-pool does not import pg, so only the match of the name can stop it.
  const { pg, pool } = await child(
    [notInstalled('pg')],
    `console.log(JSON.stringify({
      pg: await outcome(() => import('pg')),
      pool: await outcome(() => import('pg-pool')),
    }));`,
  );

  assert.ok(typeof pg === 'object');
  assert.equal(pg.code, 'ERR_MODULE_NOT_FOUND');
  assert.equal(pool, 'loaded');
});

test('one preload hides each package that it names', async () => {
  const { msw, pg } = await child(
    [notInstalled('msw', 'pg')],
    `console.log(JSON.stringify({
      msw: await outcome(() => import('msw')),
      pg: await outcome(() => import('pg')),
    }));`,
  );

  assert.ok(typeof msw === 'object' && typeof pg === 'object');
  assert.deepEqual(
    [msw.code, pg.code],
    ['ERR_MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'],
  );
});

test('preloads compose: each hides its package, and a preload before them still resolves its own specifier', async () => {
  // A preload of the caller, before the others: it resolves a specifier of its own.
  const own = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== 'the-answer') return nextResolve(specifier, context);
        return { url: 'data:text/javascript,export default 42', shortCircuit: true };
      },
    });
  `)}`;

  const outcomes = await child(
    [own, notInstalled('msw'), notInstalled('pg')],
    `console.log(JSON.stringify({
      msw: (await outcome(() => import('msw'))).code,
      pg: (await outcome(() => import('pg'))).code,
      answer: (await import('the-answer')).default,
      semver: await outcome(() => import('semver')),
    }));`,
  );

  assert.deepEqual(outcomes, {
    msw: 'ERR_MODULE_NOT_FOUND',
    pg: 'ERR_MODULE_NOT_FOUND',
    answer: 42,
    semver: 'loaded',
  });
});

test('the preload works from NODE_OPTIONS', async () => {
  const { stdout } = await spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      const code = async (name) => {
        try {
          await import(name);
          return 'loaded';
        } catch (error) {
          return error.code;
        }
      };
      console.log(JSON.stringify([await code('msw'), await code('pg')]));
      `,
    ],
    {
      env: { NODE_OPTIONS: `--import=${notInstalled('msw', 'pg')}` },
    },
  );

  assert.deepEqual(JSON.parse(stdout), [
    'ERR_MODULE_NOT_FOUND',
    'ERR_MODULE_NOT_FOUND',
  ]);
});

test('the built area gives a preload that a consumer can use', async () => {
  // A consumer imports the build: its preload is the .js file next to it.
  const { stdout: preload } = await spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    const { notInstalled } = await import('@zukhruf/testing/preload');
    console.log(notInstalled('msw'));
    `,
  ]);

  const { msw } = await child(
    [preload],
    `console.log(JSON.stringify({ msw: await outcome(() => import('msw')) }));`,
  );

  assert.ok(typeof msw === 'object');
  assert.equal(msw.code, 'ERR_MODULE_NOT_FOUND');
});

// Compile-only: this function never runs.
function checkTypes() {
  // @ts-expect-error A preload hides at least one package.
  notInstalled();
}
