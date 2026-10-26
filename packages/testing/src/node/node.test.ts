import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { TemporaryFiles } from '../fs/temporary-files.ts';
import {
  describe as parameterizedDescribe,
  it as parameterizedIt,
  suite as parameterizedSuite,
  test as parameterizedTest,
} from './index.ts';

const implementation = import.meta.resolve('@zukhruf/testing/node');

async function run(body: string, ...args: string[]) {
  await using directory = await new TemporaryFiles().directory('testing-node-');
  const file = join(directory.path, 'cases.mjs');
  await writeFile(
    file,
    `import assert from 'node:assert/strict';
import { test, it, suite, describe } from ${JSON.stringify(implementation)};
${body}`,
  );
  return runFiles([file], ['--test-reporter=tap', ...args]);
}

function runFiles(files: readonly string[], args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=5000', ...args, ...files],
    {
      encoding: 'utf8',
      timeout: 10000,
      // A runner launched from a test worker would otherwise skip its files.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test('aliases keep native identity, contexts, mocks, options and rows', async () => {
  const result = await run(`
    const native = await import('node:test');
    assert.equal(test, native.test); assert.equal(test, it);
    assert.equal(suite, native.suite); assert.equal(suite, describe);
    assert.equal(test.each, it.each); assert.equal(suite.each, describe.each);
    void test.each([{name:'object', expected:2}], row=>test(row.name, {timeout:500}, async t=>{
      const target = {value:()=>1}; t.mock.method(target, 'value', ()=>row.expected);
      await Promise.resolve(); t.assert.equal(target.value(),2);
      assert.equal(t.signal.aborted,false);
    }));
    void it.each([['tuple',3]], ([name,value])=>it(name, t=>t.assert.equal(value,3)));
    void test.each(['scalar'], value=>test(value, t=>t.assert.equal(value,'scalar')));
    test('native still works', t=>t.assert.equal(1,1));
  `);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.stdout.match(/^ok \d+ - .+$/gm), [
    'ok 1 - object',
    'ok 2 - tuple',
    'ok 3 - scalar',
    'ok 4 - native still works',
  ]);
});

test('awaited cases attach to their parent and complete disposal before resolving', async () => {
  const result = await run(`
    test('parent', async t => {
      const closed = [];
      await Promise.resolve();
      await test.each([1,2], n=>test('child '+n, async child=>{
        await using resource = {async [Symbol.asyncDispose](){await Promise.resolve();closed.push(n);}};
        await Promise.resolve();
        assert.equal(child.fullName,'parent > child '+n);
        child.assert.equal(typeof n,'number');
      }));
      t.assert.deepEqual(closed,[1,2]);
    });
  `);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.stdout.match(/^ *ok \d+ - .+$/gm), [
    '    ok 1 - child 1',
    '    ok 2 - child 2',
    'ok 1 - parent',
  ]);
});

test('context.test registration participates in the native parent plan', async () => {
  const result = await run(`
    test('parent', async t => {
      t.plan(2);
      await test.each([1,2], n => t.test('child '+n, child => child.assert.equal(typeof n, 'number')));
    });
  `);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^ok 1 - parent$/m);
});

test('suite cases preserve per-test allocation', async () => {
  const result = await run(`
    const stores = [{name:'A',open:()=>({value:1})},{name:'B',open:()=>({value:2})}];
    void describe.each(stores, store=>describe(store.name, ()=>{
      test('opens fresh', t=>t.assert.ok(store.open()!==store.open()));
      void test.each([1,2], n=>test('sample '+n, t=>t.assert.ok(store.open().value>0)));
    }));
  `);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^# tests 6$/m);
  assert.match(result.stdout, /^# suites 2$/m);
  assert.deepEqual(result.stdout.match(/^ {4}ok \d+ - .+$/gm), [
    '    ok 1 - opens fresh',
    '    ok 2 - sample 1',
    '    ok 3 - sample 2',
    '    ok 1 - opens fresh',
    '    ok 2 - sample 1',
    '    ok 3 - sample 2',
  ]);
});

test('native name filtering selects individual rows', async () => {
  const result = await run(
    `void test.each([1,2,3], n=>test('keep: '+n, t=>t.assert.equal(n,2)));`,
    '--test-name-pattern=keep: 2',
  );
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.stdout.match(/^ok \d+ - .+$/gm), ['ok 1 - keep: 2']);
});

test('skip and todo remain Node options without a second options language', async () => {
  const result = await run(`
    void test.each([1,2], n=>test('skip '+n, {skip:'platform'}, ()=>{throw new Error('must not run');}));
    void test.each([1], n=>test('todo '+n, {todo:'unfinished'}, ()=>{throw new Error('expected');}));
  `);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.stdout.match(/^ok \d+ - .+$/gm), [
    'ok 1 - skip 1 # SKIP platform',
    'ok 2 - skip 2 # SKIP platform',
  ]);
  assert.match(result.stdout, /^not ok 3 - todo 1 # TODO unfinished$/m);
});

test('a failed row fails the process while remaining rows still run', async () => {
  const result = await run(
    `void test.each([1,2,3], n=>test('row '+n, t=>t.assert.notEqual(n,2)));`,
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.match(/^ok \d+ - .+$/gm), [
    'ok 1 - row 1',
    'ok 3 - row 3',
  ]);
  assert.match(result.stdout, /^not ok 2 - row 2$/m);
  assert.match(result.stdout, /location: '[^'\n]*cases\.mjs:\d+:\d+'/);
  assert.match(result.stdout, /cases\.mjs:\d+/);
});

test('Node controls sibling concurrency through the parent options', async () => {
  const result = await run(`
    test('parent', {concurrency:2,timeout:1000}, async t => {
      const started=[];
      const gate=Promise.withResolvers();
      await test.each([1,2], n=>test('child '+n, async ()=>{
        started.push(n);
        if(started.length===2) gate.resolve();
        await gate.promise;
      }));
      t.assert.deepEqual(started,[1,2]);
    });
  `);
  assert.equal(result.status, 0, result.stdout);
});

test('a failed awaited row fails its parent through the native runner', async () => {
  const result = await run(`
    test('parent', async () => {
      await test.each([1,2], n=>test('child '+n, t=>t.assert.notEqual(n,2)));
    });
  `);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^not ok 1 - parent$/m);
  assert.match(result.stdout, /failureType: 'subtestsFailed'/);
});

test('async row failure disposes its resources', async () => {
  const result = await run(`
    const closed=[];
    void test.each([1,2], n=>test('async '+n, async t=>{
      await using resource={async [Symbol.asyncDispose](){closed.push(n);}};
      await Promise.resolve(); t.assert.notEqual(n,1);
    }));
    test('cleanup', t=>t.assert.deepEqual(closed,[1,2]));
  `);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ok 3 - cleanup$/m);
});

test('empty tables fail during registration', async () => {
  const result = await run(`
    assert.throws(()=>test.each([],()=>{throw new Error('must not register');}),/at least one case/);
    assert.throws(()=>suite.each([],()=>{throw new Error('must not register');}),/at least one case/);
    test('checked',()=>{});
  `);
  assert.equal(result.status, 0, result.stdout);
});

test('registration callbacks must return a native declaration promise', async () => {
  const result = await run(`
    assert.throws(()=>test.each([1],()=>{}), /must return test/);
    assert.throws(()=>suite.each([1],String), /must return test/);
    test('checked',()=>{});
  `);
  assert.equal(result.status, 0, result.stdout);
});

test('native spec and JUnit reporters retain row names, failures and directives', async () => {
  await using directory = await new TemporaryFiles().directory(
    'testing-node-reports-',
  );
  const file = join(directory.path, 'reports.mjs');
  const report = join(directory.path, 'report.xml');
  await writeFile(
    file,
    `
    import {test, suite} from ${JSON.stringify(implementation)};
    void suite.each(['store'], name=>suite(name, ()=>{
      void test.each([1,2,3], n=>test('row '+n, t=>t.assert.notEqual(n,2)));
      void test.each([1], n=>test('skip '+n, {skip:'platform'}, ()=>{throw new Error('must not run');}));
      void test.each([1], n=>test('todo '+n, {todo:'unfinished'}, ()=>{}));
    }));
  `,
  );
  const result = runFiles(
    [file],
    [
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=junit',
      '--test-reporter-destination=' + report,
    ],
  );
  assert.equal(result.status, 1, result.stdout);
  for (const name of ['store', 'row 1', 'row 2', 'row 3', 'skip 1', 'todo 1']) {
    assert.ok(result.stdout.includes(name), result.stdout);
  }
  assert.match(result.stdout, /tests 5/);
  assert.match(result.stdout, /fail 1/);
  assert.match(result.stdout, /reports\.mjs:\d+/);
  const xml = await readFile(report, 'utf8');
  assert.match(
    xml,
    /<testsuite name="store"[^>]*tests="5"[^>]*failures="1"[^>]*skipped="2"/,
  );
  assert.deepEqual(
    Array.from(xml.matchAll(/<testcase name="([^"]+)"/g), (match) => match[1]),
    ['row 1', 'row 2', 'row 3', 'skip 1', 'todo 1'],
  );
  assert.match(
    xml,
    /<testcase name="row 2"[^>]*failure="2 != 2">\s*<failure type="testCodeFailure"/,
  );
  assert.match(xml, /<skipped type="skipped" message="platform"\/>/);
  assert.match(xml, /<skipped type="todo" message="unfinished"\/>/);
  assert.match(xml, /reports\.mjs:\d+/);
  assert.equal(
    Array.from(xml.matchAll(/<testcase[^>]*file="[^"]*reports\.mjs"/g)).length,
    5,
  );
});

test('native snapshots use each entry file and detect a changed row', async () => {
  await using directory = await new TemporaryFiles().directory(
    'testing-node-snapshots-',
  );
  const files = [
    join(directory.path, 'first.mjs'),
    join(directory.path, 'second.mjs'),
  ] as const;
  for (const [index, file] of files.entries()) {
    await writeFile(
      file,
      `
      import {test} from ${JSON.stringify(implementation)};
      void test.each([1,2], n=>test('snapshot '+n, t=>{
        t.assert.equal(t.filePath, ${JSON.stringify(file)});
        t.assert.snapshot({file:${index}, n});
      }));
    `,
    );
  }
  const update = runFiles(files, [
    '--test-reporter=tap',
    '--test-update-snapshots',
  ]);
  assert.equal(update.status, 0, update.stdout);
  for (const [index, file] of files.entries()) {
    const snapshot = await readFile(file + '.snapshot', 'utf8');
    assert.match(snapshot, /exports\[`snapshot 1 1`\]/);
    assert.match(snapshot, /exports\[`snapshot 2 1`\]/);
    assert.ok(snapshot.includes(`"file": ${index}`), snapshot);
  }
  const verify = runFiles(files, ['--test-reporter=tap']);
  assert.equal(verify.status, 0, verify.stdout);
  await writeFile(
    files[0],
    (await readFile(files[0], 'utf8')).replace('file:0', 'file:99'),
  );
  const changed = runFiles(files, ['--test-reporter=tap']);
  assert.equal(changed.status, 1, changed.stdout);
  assert.match(changed.stdout, /^not ok 1 - snapshot 1$/m);
  assert.match(changed.stdout, /ERR_ASSERTION/);
});

for (const registration of ['test', 'suite'] as const) {
  test(`saved failure reruns execute failed ${registration} rows across files`, async () => {
    await using directory = await new TemporaryFiles().directory(
      'testing-node-rerun-',
    );
    const files = [
      join(directory.path, 'first.mjs'),
      join(directory.path, 'second.mjs'),
    ];
    const logs = [
      join(directory.path, 'first.log'),
      join(directory.path, 'second.log'),
    ] as const;
    const healed = join(directory.path, 'healed');
    for (const [index, file] of files.entries()) {
      const body = `t=>{
        appendFileSync(${JSON.stringify(logs[index])}, n+':'+t.attempt+'\\n');
        t.assert.ok(${index}!==1 || n!==1 || existsSync(${JSON.stringify(healed)}), 'persistent row failure');
      }`;
      const declaration =
        registration === 'test'
          ? `void test.each([1,2], n=>test('row '+n, ${body}));`
          : `void suite.each([1,2], n=>suite('store '+n, ()=>{ test('value', ${body}); }));`;
      await writeFile(
        file,
        `
        import {appendFileSync, existsSync} from 'node:fs';
        import {test, suite} from ${JSON.stringify(implementation)};
        ${declaration}
      `,
      );
    }
    const args = [
      '--test-reporter=tap',
      '--test-rerun-failures=' + join(directory.path, 'state.json'),
    ];
    const first = runFiles(files, args);
    assert.equal(first.status, 1, first.stdout);
    assert.equal(await readFile(logs[0], 'utf8'), '1:0\n2:0\n');
    assert.equal(await readFile(logs[1], 'utf8'), '1:0\n2:0\n');

    const second = runFiles(files, args);
    assert.equal(
      second.status,
      1,
      'A persistently failing row must execute and keep the rerun failing.\n' +
        second.stdout,
    );
    assert.equal(await readFile(logs[0], 'utf8'), '1:0\n2:0\n');
    assert.equal(await readFile(logs[1], 'utf8'), '1:0\n2:0\n1:1\n');

    await writeFile(healed, 'fixed');
    const fixed = runFiles(files, args);
    assert.equal(fixed.status, 0, fixed.stdout);
    assert.equal(await readFile(logs[1], 'utf8'), '1:0\n2:0\n1:1\n1:2\n');

    const replay = runFiles(files, args);
    assert.equal(replay.status, 0, replay.stdout);
    assert.equal(await readFile(logs[0], 'utf8'), '1:0\n2:0\n');
    assert.equal(await readFile(logs[1], 'utf8'), '1:0\n2:0\n1:1\n1:2\n');
  });
}

test('entrypoint imports no optional database or Docker modules', async () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,context,next){
        if (!specifier.startsWith('node:') && !specifier.startsWith('file:')) throw new Error(specifier);
        return next(specifier,context);
      }});
      const {test}=await import(${JSON.stringify(implementation)});
      if (typeof test.each!=='function') throw new Error('missing each');
    `,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      // A runner launched from a test worker would otherwise skip its files.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

// Compile-only assertions: deliberately invalid calls must never execute.
function checkTypes() {
  void parameterizedTest.each(
    ['sql/results.json', '.internal/a.md'],
    (path, index) =>
      test(`${path} ${index.toFixed()}`, (t) => {
        const context: TestContext = t;
        context.assert.equal(typeof path.toUpperCase(), 'string');
      }),
  );
  void parameterizedIt.each(
    [
      { name: 'oversized', reason: 'summary-too-large' },
      { name: 'empty', reason: 'empty-summary' },
    ] as const,
    (row) =>
      parameterizedIt(row.name, async (t) => {
        const reason: 'summary-too-large' | 'empty-summary' = row.reason;
        t.assert.equal(typeof reason, 'string');
      }),
  );
  void parameterizedTest.each(
    [
      ['name', null],
      ['count', 1.5],
      ['tags', ['x', 1]],
    ] as const,
    (row) =>
      test(row[0], (t) => {
        if (row[0] === 'count') {
          const value: 1.5 = row[1];
          t.assert.equal(value, 1.5);
        }
      }),
  );
  const stores = [{ name: 'one', open: () => ({ value: 1 }) }];
  void parameterizedDescribe.each(stores, (store) =>
    parameterizedDescribe(store.name, { concurrency: false }, () => {
      test('fresh instance', (t) => t.assert.equal(store.open().value, 1));
    }),
  );
  void parameterizedSuite.each([1], (n) =>
    parameterizedSuite(String(n), (s) => {
      void s.filePath;
    }),
  );
  void parameterizedTest.each([1], (n) =>
    test(
      String(n),
      { timeout: 1000, skip: false, concurrency: false },
      async (t) => {
        t.assert.equal(n.toFixed(), '1');
      },
    ),
  );

  // @ts-expect-error The native import must not advertise an extension it never loaded.
  void test.each([1], (n) => test(String(n), () => {}));
  // @ts-expect-error A numeric row cannot be handled by a string callback.
  void parameterizedTest.each([1, 2], (row: string) => test(row, () => {}));
  // @ts-expect-error The callback must return the declaration promise.
  void parameterizedTest.each([1], () => {});
  // @ts-expect-error The old name/body overload does not preserve caller locations.
  void parameterizedTest.each([1], String, () => {});
  void parameterizedTest.each([1], (n) =>
    // @ts-expect-error Native names must be strings.
    test(n, () => {}),
  );
  void parameterizedTest.each([1], (n) =>
    // @ts-expect-error Options belong to Node and do not include a custom retries DSL.
    test(String(n), { retries: 2 }, () => {}),
  );
  void parameterizedSuite.each([1], (n) =>
    parameterizedSuite(String(n), (s) => {
      // @ts-expect-error The suite context is not a TestContext.
      s.assert.equal(1, 1);
    }),
  );
}

test('the source condition exposes the same Node extension', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=@zukhruf/source',
      '--input-type=module',
      '--eval',
      `
      import { test, it, suite, describe } from '@zukhruf/testing/node';
      if (test !== it || suite !== describe) throw new Error('aliases differ');
      void test.each([1], value => test(String(value), t => t.assert.equal(value, 1)));
    `,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
