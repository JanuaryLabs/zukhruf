import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import {
  typedRuleTester,
  typescriptRuleTester,
} from '../testing/rule-tester.ts';
import rule from './no-tabular-test.ts';

void test.each(
  [
    {
      // packages/async backoff.test.ts:33.
      name: 'each invalid options object of a named table into a new subject',
      line: 4,
      code: [
        `test('invalid options are a RangeError', () => {`,
        `  const valid = { initial: 100, multiplier: 2, max: 1000 };`,
        `  const invalid = [{ ...valid, initial: 0 }, { ...valid, multiplier: 0.5 }];`,
        `  for (const options of invalid) {`,
        `    assert.throws(() => new Backoff(options), RangeError);`,
        `  }`,
        `});`,
      ],
    },
    {
      // packages/sqlite/federation federation.test.ts:587.
      name: 'each row that resets a value declared outside the loop with = before its act',
      line: 5,
      code: [
        `import { Federation } from './federation.ts';`,
        `test('PRAGMAs locate each database name', () => {`,
        `  const located: string[] = [];`,
        `  using federation = new Federation({ locate: (name) => located.push(name) });`,
        `  for (const name of ['a', 'b']) {`,
        `    located.length = 0;`,
        `    assert.deepEqual(federation.query(\`PRAGMA \${name}.table_info(t)\`).rows, []);`,
        `    assert.deepEqual(located, [name]);`,
        `  }`,
        `});`,
      ],
    },
    {
      // packages/information-filtering/relevance-filtering utility-threshold.test.ts:47.
      name: 'each cost written out in the loop head into a new subject',
      line: 2,
      code: [
        `test('costs that give no threshold are a RangeError', () => {`,
        `  for (const costs of [{ falseAlarm: -1, miss: 2 }, { falseAlarm: 0, miss: 0 }])`,
        `    assert.throws(() => new UtilityThreshold(costs), RangeError, JSON.stringify(costs));`,
        `});`,
      ],
    },
    {
      // packages/docker images.test.ts:642.
      name: 'each API version starts its own fake engine and calls the call of its row',
      line: 7,
      code: [
        `import { fakeEngine } from './testing/fake-engine.ts';`,
        `test('an old engine refuses each call', async () => {`,
        `  const calls = [`,
        `    { apiVersion: '1.40', call: (docker) => docker.images.list() },`,
        `    { apiVersion: '1.51', call: (docker) => docker.images.save(['alpine:3']) },`,
        `  ];`,
        `  for (const { apiVersion, call } of calls) {`,
        `    await using engine = await fakeEngine({ apiVersion });`,
        `    await using docker = await Docker.connect({ host: engine.host });`,
        `    await assert.rejects(call(docker), UnsupportedEngineError);`,
        `  }`,
        `});`,
      ],
    },
    {
      // packages/nx dokploy generator.test.ts:634: a matrix reports once, at the outermost loop.
      name: 'a nested matrix of rows, once at the outermost loop',
      line: 3,
      code: [
        `import { dokployGenerator, workspace } from './generator.ts';`,
        `test('tofu fmt would change no .tf file the generator writes', async () => {`,
        `  for (const postgres of [true, false]) {`,
        `    for (const registry of [true, false]) {`,
        `      const tree = await workspace(postgres);`,
        `      await dokployGenerator(tree, { registry });`,
        `      assert.equal(fmt(tree).status, 0);`,
        `    }`,
        `  }`,
        `});`,
      ],
    },
    {
      name: 'each statement into a database that the test awaited before the loop',
      line: 4,
      code: [
        `import { openDatabase } from './database.ts';`,
        `test('each malformed statement is refused', async () => {`,
        `  const db = await openDatabase(':memory:');`,
        `  for (const sql of ['SELEC 1', 'DROP']) await assert.rejects(db.exec(sql), DatabaseError);`,
        `});`,
      ],
    },
    {
      // packages/sqlite/federation federation.test.ts:612: `using` makes a fixture, though an assertion outside the loop reads it.
      name: 'each statement into a fixture declared with using',
      line: 4,
      code: [
        `test('a statement on an unknown database is refused', () => {`,
        `  using federation = new Federation({ main: ':memory:' });`,
        `  assert.deepEqual(federation.query('SELECT 1').rows, [[1]]);`,
        `  for (const sql of ['SELECT * FROM nope.t', 'DETACH nope']) {`,
        `    assert.throws(() => federation.query(sql), UnknownDatabaseError);`,
        `  }`,
        `});`,
      ],
    },
  ],
  ({ name, line, code }) =>
    test(`no-tabular-test reports ${name}`, () => {
      typescriptRuleTester().run('no-tabular-test', rule, {
        valid: [],
        invalid: [
          {
            code: code.join('\n'),
            errors: [{ messageId: 'tabularTest', line }],
          },
        ],
      });
    }),
);

void test.each(
  [
    {
      // packages/docker disposal.test.ts:212.
      name: 'two promises of one act',
      code: [
        `test('dispose rejects the calls in flight and later calls', async () => {`,
        `  const docker = await Docker.connect({ host });`,
        `  const inFlight = docker.info();`,
        `  const disposing = docker[Symbol.asyncDispose]();`,
        `  const late = docker.info();`,
        `  await disposing;`,
        `  for (const each of [inFlight, late]) {`,
        `    await assert.rejects(each, DockerError);`,
        `  }`,
        `});`,
      ],
    },
    {
      name: 'two promises of one act handed to a helper',
      code: [
        `import { outcome } from './testing/outcome.ts';`,
        `test('dispose rejects the calls in flight and later calls', async () => {`,
        `  const docker = await Docker.connect({ host });`,
        `  const inFlight = docker.info();`,
        `  const late = docker.info();`,
        `  for (const each of [inFlight, late]) assert.equal(await outcome(each), 'rejected');`,
        `});`,
      ],
    },
    {
      // packages/nx prisma generator.test.ts:127.
      name: 'the files of one tree that the act wrote',
      code: [
        `test('the generator writes the client files', async () => {`,
        `  const tree = createTreeWithEmptyWorkspace();`,
        `  await prismaGenerator(tree, { name: 'db' });`,
        `  for (const path of ['db/schema.prisma', 'db/client.ts']) assert.ok(tree.exists(path));`,
        `});`,
      ],
    },
    {
      // elt destinations/sqlite derived-during-pass.test.ts:641 and
      // destinations/sqlserver computed-dataset.test.ts:789.
      name: 'rows that add to a value declared outside the loop, a sequence of passes',
      code: [
        `import { waitFor } from '@zukhruf/testing/async';`,
        `import { counts } from './counts.ts';`,
        `test('each pass loads the rows that the source gives now', async () => {`,
        `  const source = new FakeSource();`,
        `  for (const ids of [['r1', 'r2'], ['r1', 'r2', 'r3']]) {`,
        `    source.ids = ids;`,
        `    source.dial.turns += 1;`,
        `    await waitFor(async () => assert.equal(await counts(), ids.length));`,
        `  }`,
        `});`,
      ],
    },
    {
      name: 'a table of one row',
      code: [
        `import { parse } from './parse.ts';`,
        `test('parse', () => {`,
        `  for (const input of ['a']) assert.ok(parse(input));`,
        `});`,
      ],
    },
    {
      // packages/git-hooks snapshot.test.ts:166.
      name: 'the names of one environment that the act printed',
      code: [
        `test('git gives the hook its variables', async () => {`,
        `  const result = await repo.commit('first');`,
        `  const hook = printed(result.stderr, 'env').hook;`,
        `  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE'])`,
        `    assert.ok(name in hook, \`git must give the hook \${name}\`);`,
        `});`,
      ],
    },
    {
      // packages/embeddings vector-search.test.ts:93.
      name: 'the documents of one collection compared with each search',
      code: [
        `test('each search finds what the collection finds', () => {`,
        `  const documents = [{ id: 'a' }, { id: 'b' }];`,
        `  const collection = new Collection(documents);`,
        `  const searches = [new VectorSearch({ table: 'a' }), new VectorSearch({ table: 'b' })];`,
        `  assert.deepEqual(collection.nearest('a', { k: 4 }), [{ id: 'b' }]);`,
        `  for (const search of searches) {`,
        `    for (const { id } of documents)`,
        `      assert.deepEqual(search.nearest(id, { k: 4 }), collection.nearest(id, { k: 4 }));`,
        `  }`,
        `});`,
      ],
    },
    {
      // packages/pool pool-workers.test.ts:4341: waitFor runs its callback again, so the loop cannot become test.each.
      name: 'a loop inside a waitFor callback',
      code: [
        `import { running } from './testing/held-workers.ts';`,
        `test('the ends of a and b wake the owner', async (t) => {`,
        `  await waitFor(() => {`,
        `    for (const id of ['c', 'd']) assert.ok(running(workers, id), \`job \${id} runs\`);`,
        `  }, { signal: t.signal });`,
        `});`,
      ],
    },
    {
      name: 'a row into new Set and new RangeError, built-ins that make values',
      code: [
        `test('built-ins', () => {`,
        `  for (const value of [1, 2]) {`,
        `    assert.equal(new Set([value]).size, 1);`,
        `    assert.equal(new RangeError(String(value)).message, String(value));`,
        `  }`,
        `});`,
      ],
    },
    {
      name: 'a loop that declares subtests, which is prefer-each’s',
      code: [
        `import { parse } from './parse.ts';`,
        `test('parse', async (t) => {`,
        `  for (const input of ['a', 'b']) {`,
        `    await t.test(input, () => assert.ok(parse(input)));`,
        `  }`,
        `});`,
      ],
    },
    {
      name: 'a loop outside a test case',
      code: [
        `import { parse } from './parse.ts';`,
        `for (const input of ['a', 'b']) assert.ok(parse(input));`,
      ],
    },
  ],
  ({ name, code }) =>
    test(`no-tabular-test passes ${name}`, () => {
      typescriptRuleTester().run('no-tabular-test', rule, {
        valid: [{ code: code.join('\n') }],
        invalid: [],
      });
    }),
);

/** A workspace whose test support and classes give the types that the typed cases read. */
async function typedWorkspace() {
  return fixtureWorkspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'esnext',
        module: 'nodenext',
        lib: ['esnext'],
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ['**/*.ts'],
    }),
    'src/counter.ts': [
      `export class Counter {`,
      `  #counts = new Map<string, number>();`,
      `  add(key: string): void { this.#counts.set(key, this.read(key) + 1); }`,
      `  read(key: string): number { return this.#counts.get(key) ?? 0; }`,
      `}`,
    ].join('\n'),
    'src/testing/probe.ts': [
      `export interface Probe { affected(file: string): string[] }`,
      `export declare function probe(): Probe;`,
    ].join('\n'),
    'src/testing/held-workers.ts': [
      `export class HeldWorkers { running(id: string): boolean { return id.length > 0; } }`,
    ].join('\n'),
    'src/docker.ts': [
      `export class Container { readFile(path: string): Promise<Uint8Array> { return Promise.resolve(new Uint8Array(path.length)); } }`,
      `export declare function connect(): Promise<{ containers: { create(image: string): Promise<Container> } }>;`,
    ].join('\n'),
    // On disk, so the tsconfig holds the case, as no-unhandled-readline-error.test.ts explains.
    'src/case.test.ts': 'export {};\n',
  });
}

/** Cases that only the types tell from a check of one result. */
const typedCases = [
  {
    // packages/snapshot-differential snapshot-differential.test.ts:1332: an instance of a class, acted on with each row.
    name: 'each row into a method of a class instance that an assertion outside the loop also reads',
    code: [
      `import { Counter } from './counter.ts';`,
      `test('a key that is blank is a RangeError', () => {`,
      `  const counter = new Counter();`,
      `  assert.equal(counter.read('a'), 0);`,
      `  for (const key of ['', ' ']) assert.throws(() => counter.add(key), RangeError);`,
      `});`,
    ],
  },
  {
    // packages/nx generated-sources.test.ts:347: a value of a type that test support declares is a fixture.
    name: 'each row into a fixture of test support',
    code: [
      `import { probe } from './testing/probe.ts';`,
      `test('each changed file has its projects', () => {`,
      `  const nx = probe();`,
      `  assert.ok(nx);`,
      `  for (const file of ['a.ts', 'b.ts']) assert.deepEqual(nx.affected(file), [file]);`,
      `});`,
    ],
  },
];

void test.each(typedCases, ({ name, code }) =>
  test(`no-tabular-test with type information reports ${name}`, async () => {
    await using fixture = await typedWorkspace();
    typedRuleTester(fixture.root).run('no-tabular-test', rule, {
      valid: [],
      invalid: [
        {
          filename: fixture.path('src/case.test.ts'),
          code: code.join('\n'),
          errors: [{ messageId: 'tabularTest', line: 5 }],
        },
      ],
    });
  }),
);

void test.each(typedCases, ({ name, code }) =>
  test(`no-tabular-test without type information passes ${name}`, () => {
    typescriptRuleTester().run('no-tabular-test', rule, {
      valid: [{ code: code.join('\n') }],
      invalid: [],
    });
  }),
);

void test.each(
  [
    {
      // packages/docker images-build.test.ts:398: a container that a method of another value returns reads the act's product.
      name: 'the paths of one image read through a container that a method returned',
      code: [
        `import { connect } from './docker.ts';`,
        `test('the build context keeps the kept files', async () => {`,
        `  const docker = await connect();`,
        `  const container = await docker.containers.create('built');`,
        `  for (const path of ['/ctx/a.md', '/ctx/b.log']) await assert.rejects(container.readFile(path), PathNotFoundError);`,
        `});`,
      ],
    },
    {
      // packages/pool pool-workers.test.ts:4341: a test's own class instance that only reads its state, inside waitFor.
      name: 'a method of a class instance called inside a waitFor callback',
      code: [
        `import { HeldWorkers } from './testing/held-workers.ts';`,
        `test('the ends of a and b wake the owner', async (t) => {`,
        `  const workers = new HeldWorkers();`,
        `  await waitFor(() => {`,
        `    for (const id of ['c', 'd']) assert.ok(workers.running(id));`,
        `  }, { signal: t.signal });`,
        `});`,
      ],
    },
  ],
  ({ name, code }) =>
    test(`no-tabular-test with type information passes ${name}`, async () => {
      await using fixture = await typedWorkspace();
      typedRuleTester(fixture.root).run('no-tabular-test', rule, {
        valid: [
          { filename: fixture.path('src/case.test.ts'), code: code.join('\n') },
        ],
        invalid: [],
      });
    }),
);
