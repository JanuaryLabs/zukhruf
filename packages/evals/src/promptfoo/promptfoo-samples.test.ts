import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  type AfterAllExtensionHookContext,
  type EvaluateResult,
  ResultFailureReason,
} from 'promptfoo';

import { TemporaryFiles } from '@zukhruf/fs';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { Bootstrap, Ratio, RunLog } from '../index.ts';
import { TextVarsCase } from '../structured/index.ts';
import {
  type PromptfooReaders,
  type PromptfooResult,
  PromptfooSamples,
  UnscoredAnswerError,
} from './index.ts';

const execFileAsync = promisify(execFile);

type Exported = {
  readonly results: {
    readonly prompts: readonly {
      readonly metrics: {
        readonly namedScores: Readonly<Record<string, number>>;
        readonly namedScoreWeights: Readonly<Record<string, number>>;
      };
    }[];
    readonly results: readonly PromptfooResult[];
  };
};

// The readers of these tests: the test id is the var q, the case is the
// expected value of the vars with weight 1, and the answer is the output.
const readers: PromptfooReaders<
  unknown,
  { readonly expected: unknown; readonly weight: number }
> = {
  test: (result) => String(result.vars['q']),
  cases: { from: (vars) => ({ expected: vars['expected'], weight: 1 }) },
  answer: (output) => output,
};

// Runs `promptfoo eval` in the folder with the provider given as the body of
// its callApi(prompt), on a test for each q of `tests`, each scored by a
// PromptfooAssertion of the recall against its expected value, and gives
// the export of the run. `assertion` is the body of the assertion module's
// function (output, context), which grades with `grade` by default.
async function evaluate(
  folder: string,
  {
    callApi,
    tests,
    assertion = 'return grade(output, context);',
    prompts = ['{{q}}'],
    args = [],
    extensions = [],
  }: {
    readonly callApi: string;
    readonly assertion?: string;
    readonly tests: readonly {
      readonly q: string;
      readonly expected: unknown;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[];
    readonly prompts?: readonly string[];
    readonly args?: readonly string[];
    readonly extensions?: readonly string[];
  },
): Promise<Exported> {
  const source = (path: string) => new URL(path, import.meta.url).href;
  await writeFile(
    join(folder, 'assertion.ts'),
    `import { Recall, ScorerSet } from '${source('../index.ts')}';
import { ConfigCase, TreeWalk, ValueMatches } from '${source('../structured/index.ts')}';
import { PromptfooAssertion } from '${source('./index.ts')}';

const grade = new PromptfooAssertion(
  new ScorerSet({ recall: new Recall(new ValueMatches()) }, { comparer: new TreeWalk() }),
  new ConfigCase(),
).grade;

export default (output: unknown, context: { vars: Record<string, unknown> }) => {
  ${assertion}
};
`,
  );
  await writeFile(
    join(folder, 'provider.ts'),
    `import { FailedCall } from '${source('./index.ts')}';

export default class {
  id() {
    return 'provider';
  }
  async callApi(prompt: string) {
    void FailedCall;
    ${callApi}
  }
}
`,
  );
  await writeFile(
    join(folder, 'promptfooconfig.ts'),
    `export default {
  prompts: ${JSON.stringify(prompts)},
  providers: ['file://provider.ts'],
  extensions: ${JSON.stringify(extensions)},
  tests: ${JSON.stringify(
    tests.map(({ q, expected, metadata }) => ({
      vars: { q, expected },
      ...(metadata === undefined ? {} : { metadata }),
      assert: [
        {
          type: 'javascript',
          value: 'file://assertion.ts',
          config: { expected },
        },
      ],
    })),
  )},
};
`,
  );
  const manifest = findPackageJSON('promptfoo', import.meta.url);
  assert.ok(manifest, 'promptfoo is a devDependency of the package');
  const { bin }: { bin: { promptfoo: string } } = JSON.parse(
    await readFile(manifest, 'utf8'),
  );
  await execFileAsync(
    process.execPath,
    [
      join(manifest, '..', bin.promptfoo),
      'eval',
      '-c',
      'promptfooconfig.ts',
      '--no-cache',
      '--no-table',
      '--no-progress-bar',
      '-o',
      'out.json',
      ...args,
    ],
    {
      cwd: folder,
      timeout: 120_000,
      env: {
        ...process.env,
        PROMPTFOO_CONFIG_DIR: join(folder, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
        PROMPTFOO_DISABLE_SHARING: 'true',
        PROMPTFOO_PASS_RATE_THRESHOLD: '0',
      },
    },
  ).catch((cause: unknown) => {
    // promptfoo exits 100 when a test fails or errs; the export is written.
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 100
    )
      return;
    throw cause;
  });
  return JSON.parse(await readFile(join(folder, 'out.json'), 'utf8'));
}

test('an answered row is a sample with its case, its answer, its ratios, its metadata and the usage of its call', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return {
      output: '{"a": 1}',
      tokenUsage: {
        prompt: 10,
        completion: 5,
        total: 15,
        completionDetails: { cacheReadInputTokens: 3 },
      },
      cost: 0.01,
    };`,
    tests: [
      {
        q: 'a',
        expected: { a: 1, b: 2 },
        // An object in the metadata is not a fact that a page can show.
        metadata: {
          labels: 4,
          split: 'tuning',
          source: { file: 'pages.jsonl' },
        },
      },
    ],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  const [sample] = [
    ...new PromptfooSamples(exported.results.results, {
      ...readers,
      cases: { from: (vars) => ({ expected: vars['expected'], weight: 3 }) },
    }),
  ];

  assert.ok(sample);
  assert.deepEqual(
    {
      test: sample.test,
      epoch: sample.epoch,
      weight: sample.weight,
      case: sample.case,
      outcome: sample.outcome,
      answer: sample.answer,
      ratios: sample.scorecard.ratios,
      metadata: sample.metadata,
      latencyMs: sample.latencyMs,
      call: sample.call,
    },
    {
      test: 'a',
      epoch: 0,
      weight: 3,
      case: { expected: { a: 1, b: 2 }, weight: 3 },
      outcome: 'answered',
      answer: '{"a": 1}',
      // One of the two expected values is stated.
      ratios: new Map([['recall', new Ratio(1, 2)]]),
      metadata: { labels: 4, split: 'tuning' },
      latencyMs: row.latencyMs,
      call: {
        replayed: false,
        usage: { input: 10, output: 5, cachedInput: 3, cost: 0.01 },
      },
    },
  );
});

test('a row whose provider answered with a FailedCall is a failed sample with the reason', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return new FailedCall('the call timed out').response();`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });

  const [sample] = [...new PromptfooSamples(exported.results.results, readers)];

  assert.ok(sample);
  assert.deepEqual(
    {
      outcome: sample.outcome,
      answer: sample.answer,
      error: sample.outcome === 'failed' ? sample.error : undefined,
    },
    { outcome: 'failed', answer: null, error: 'the call timed out' },
  );
});

test('the repeats of a test are its epochs, in the order of the tests and then of the epochs, whatever the order of the rows', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
    args: ['--repeat', '2'],
  });

  const samples = [
    ...new PromptfooSamples(exported.results.results.toReversed(), readers),
  ];

  // The provider measured no tokens, so no answer has a usage.
  assert.deepEqual(
    samples.map(({ test, epoch, call }) => [test, epoch, call.usage]),
    [
      ['a', 0, undefined],
      ['a', 1, undefined],
      ['b', 0, undefined],
      ['b', 1, undefined],
    ],
  );
});

test('a row that the provider replayed keeps the usage that the provider gave, and a replay with no tokens and no cost has no usage', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `if (prompt === 'a')
      return { output: '{"a": 1}', cached: true, tokenUsage: { prompt: 10, completion: 5, total: 15 }, cost: 0.01 };
    if (prompt === 'b')
      return { output: '{"a": 1}', cached: true, tokenUsage: { cached: 15, total: 15 } };
    return { output: '{"a": 1}', cached: true, tokenUsage: { cached: 15, total: 15 }, cost: 0.02 };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
      { q: 'c', expected: { a: 1 } },
    ],
  });

  const samples = [...new PromptfooSamples(exported.results.results, readers)];

  assert.deepEqual(
    samples.map(({ test, call }) => [test, call]),
    [
      [
        'a',
        {
          replayed: true,
          usage: { input: 10, output: 5, cachedInput: 0, cost: 0.01 },
        },
      ],
      ['b', { replayed: true, usage: undefined }],
      [
        'c',
        {
          replayed: true,
          usage: { input: 0, output: 0, cachedInput: 0, cost: 0.02 },
        },
      ],
    ],
  );
});

test('the ratio of sums of the samples is the number that promptfoo gives the run', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: prompt === 'a' ? '{"a": 1}' : '{"b": 9}' };`,
    tests: [
      { q: 'a', expected: { a: 1, b: 2 } },
      { q: 'b', expected: { a: 1, b: 2, c: 3 } },
    ],
  });
  const log = new RunLog(
    { id: 'eval', label: 'provider', createdAt: new Date(0) },
    new PromptfooSamples(exported.results.results, readers),
  );
  let draw = 0;
  const bootstrap = new Bootstrap({
    nResamples: 1,
    // Draw each test once, in order: the resample is the run itself.
    randomIndex: () => draw++,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(log.run(), 'recall');

  const [prompt] = exported.results.prompts;
  assert.ok(prompt);
  // a states 1 of 2 values and b none of 3: 1 / 5.
  assert.deepEqual(
    [interval?.low, interval?.high],
    [
      prompt.metrics.namedScores['recall'] ?? Number.NaN,
      prompt.metrics.namedScores['recall'] ?? Number.NaN,
    ].map(
      (score) =>
        score / (prompt.metrics.namedScoreWeights['recall'] ?? Number.NaN),
    ),
  );
  assert.equal(interval?.low, 1 / 5);
});

test('each writer stores the whole that its scorer gave, and Run weighs each test by the weight of its case once', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('samples-');
  const source = (path: string) => new URL(path, import.meta.url).href;
  await writeFile(
    join(folder.path, 'assertion.ts'),
    `import { Recall, ScorerSet } from '${source('../index.ts')}';
import { ExactMatch, TextVarsCase, TreeWalk, ValueMatches } from '${source('../structured/index.ts')}';
import { AssertionModule, PromptfooAssertion, ScorerAssertion } from '${source('./index.ts')}';

const cases = new TextVarsCase();
const grade = new PromptfooAssertion(
  new ScorerSet({ recall: new Recall(new ValueMatches()) }, { comparer: new TreeWalk() }),
  cases,
).grade;
export const module = new AssertionModule(import.meta.url, {
  exact: new ScorerAssertion(new ExactMatch(), { weight: 1, threshold: 0, comparer: new TreeWalk(), cases }),
});
export default {
  grade: (output: unknown, context: { vars: Record<string, unknown> }) => grade(output, { config: context.vars }),
  ...module.functions,
};
`,
  );
  await writeFile(
    join(folder.path, 'provider.ts'),
    `export default class {
  id() {
    return 'provider';
  }
  async callApi(prompt: string) {
    return { output: prompt === 'one' ? '{"a": 1}' : '{"a": 1, "b": 9}' };
  }
}
`,
  );
  await writeFile(
    join(folder.path, 'promptfooconfig.ts'),
    `import { module } from './assertion.ts';

export default {
  prompts: ['{{q}}'],
  providers: ['file://provider.ts'],
  defaultTest: {
    assert: [
      { type: 'javascript', value: 'file://assertion.ts:grade' },
      ...module.assert('exact'),
    ],
  },
  tests: [
    { vars: { q: 'one', expected: '{"a": 1}', weight: 1 } },
    { vars: { q: 'three', expected: '{"a": 1, "b": 2}', weight: 3 } },
  ],
};
`,
  );
  const manifest = findPackageJSON('promptfoo', import.meta.url);
  assert.ok(manifest, 'promptfoo is a devDependency of the package');
  const { bin }: { bin: { promptfoo: string } } = JSON.parse(
    await readFile(manifest, 'utf8'),
  );
  await execFileAsync(
    process.execPath,
    [
      join(manifest, '..', bin.promptfoo),
      'eval',
      '-c',
      'promptfooconfig.ts',
      '--no-cache',
      '--no-table',
      '--no-progress-bar',
      '-o',
      'out.json',
    ],
    {
      cwd: folder.path,
      timeout: 120_000,
      env: {
        ...process.env,
        PROMPTFOO_CONFIG_DIR: join(folder.path, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
        PROMPTFOO_DISABLE_SHARING: 'true',
        PROMPTFOO_PASS_RATE_THRESHOLD: '0',
      },
    },
  ).catch((cause: unknown) => {
    // promptfoo exits 100 when a test fails; the export is written.
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 100
    )
      return;
    throw cause;
  });
  const exported: Exported = JSON.parse(
    await readFile(join(folder.path, 'out.json'), 'utf8'),
  );

  // Act
  const run = new RunLog(
    { id: 'eval', label: 'provider', createdAt: new Date(0) },
    new PromptfooSamples(exported.results.results, {
      test: (result) => String(result.vars['q']),
      cases: new TextVarsCase(),
      answer: (output) => output,
    }),
  ).run();

  // Assert
  assert.deepEqual(
    exported.results.results
      .toSorted((a, b) => a.testIdx - b.testIdx)
      .map((row) => row.gradingResult?.namedScoreWeights),
    [
      { recall: 1, exact: 1 },
      { recall: 2, exact: 1 },
    ],
    'Each stored weight must be the whole of the scorer, with no case weight',
  );
  // one states 1 of 1 value at weight 1, three 1 of 2 at weight 3:
  // (1·1 + 1·3) / (1·1 + 2·3) = 4/7. The exact match: (1·1 + 0·3) / (1 + 3).
  assert.deepEqual(
    [run.total('recall').ratio, run.total('exact').ratio],
    [new Ratio(4, 7), new Ratio(1, 4)],
  );
});

test('the rows of two prompts are refused, since a run of two providers is two logs', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
    prompts: ['{{q}}', 'again {{q}}'],
  });

  assert.throws(() => new PromptfooSamples(exported.results.results, readers), {
    name: 'RangeError',
    message: 'The samples of a run are the rows of one prompt. Prompts: 0, 1',
  });
});

test('a run whose error rows were neither retried nor graded is refused, and the error names each of their tests', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `if (prompt !== 'a') throw new Error('401 Unauthorized');
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
      { q: 'c', expected: { a: 1 } },
    ],
  });

  assert.throws(
    () => new PromptfooSamples(exported.results.results, readers),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message.startsWith(
        'A run with an error row that no hook graded was not retried; run promptfoo eval with --retry-errors. Errors: b (epoch 0): ',
      ) &&
      error.message.includes(', c (epoch 0): ') &&
      error.message.includes('401 Unauthorized'),
  );
});

test('a run in which an assertion threw is refused with an UnscoredAnswerError that holds each test and epoch it threw on, with the reason promptfoo wrote', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    assertion: `if (context.vars['q'] === 'b') throw new Error('the scorer broke');
  return grade(output, context);`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
    args: ['--repeat', '2'],
  });

  const read = () => new PromptfooSamples(exported.results.results, readers);

  assert.throws(read, UnscoredAnswerError);
  assert.throws(read, {
    message:
      'A run with answers that no assertion scored has no score for their tests: an assertion threw or failed without a score; fix the assertion and run promptfoo eval again. Unscored: b (epoch 0): Custom function threw error: the scorer broke, b (epoch 1): Custom function threw error: the scorer broke',
    tests: [
      {
        test: 'b',
        epoch: 0,
        reason: 'Custom function threw error: the scorer broke',
      },
      {
        test: 'b',
        epoch: 1,
        reason: 'Custom function threw error: the scorer broke',
      },
    ],
  });
});

test('a run in which an assertion returned false with no score is refused with an UnscoredAnswerError that holds the test, with the reason promptfoo wrote', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    assertion: `if (context.vars['q'] === 'b') return false;
  return grade(output, context);`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
  });

  const read = () => new PromptfooSamples(exported.results.results, readers);

  assert.throws(read, UnscoredAnswerError);
  assert.throws(read, {
    tests: [
      {
        test: 'b',
        epoch: 0,
        reason: 'Custom function returned false\nfile://assertion.ts',
      },
    ],
  });
});

test('a row whose assertion failed on its scores is an answered sample with those scores, and a row whose assertion passed with no score is one with no scores', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    assertion: `if (context.vars['q'] === 'c') return true;
  const graded = grade(output, context);
  return context.vars['q'] === 'b' ? { ...graded, pass: false, reason: 'below the bar' } : graded;`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1, b: 2 } },
      { q: 'c', expected: { a: 1 } },
    ],
  });

  const samples = [...new PromptfooSamples(exported.results.results, readers)];

  assert.deepEqual(
    exported.results.results.map(({ vars, failureReason }) => [
      vars['q'],
      failureReason,
    ]),
    [
      ['a', ResultFailureReason.NONE],
      ['b', ResultFailureReason.ASSERT],
      ['c', ResultFailureReason.NONE],
    ],
  );
  assert.deepEqual(
    samples.map(({ test, outcome, scorecard }) => [
      test,
      outcome,
      scorecard.ratios,
    ]),
    [
      ['a', 'answered', new Map([['recall', new Ratio(1, 1)]])],
      ['b', 'answered', new Map([['recall', new Ratio(1, 2)]])],
      ['c', 'answered', new Map()],
    ],
  );
});

test('after --retry-errors, the stale error row of each retried epoch gives way to its retried row', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  await writeFile(
    join(folder.path, 'extension.ts'),
    `import { writeFileSync } from 'node:fs';

// afterAll gets every row of the eval, after a retry the stale error rows too.
export async function afterAll(context: { results: unknown[] }) {
  writeFileSync('after-all.json', JSON.stringify(context.results));
}
`,
  );
  // The call of b fails while the file "fail" exists, as a 503 would.
  await writeFile(join(folder.path, 'fail'), '');
  const run = {
    callApi: `const { existsSync } = await import('node:fs');
    if (prompt === 'b' && existsSync('fail')) throw new Error('503 Service Unavailable');
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
    extensions: ['file://extension.ts:afterAll'],
  };
  await evaluate(folder.path, { ...run, args: ['--repeat', '2'] });
  await rm(join(folder.path, 'fail'));
  await evaluate(folder.path, { ...run, args: ['--retry-errors'] });
  const rows: PromptfooResult[] = JSON.parse(
    await readFile(join(folder.path, 'after-all.json'), 'utf8'),
  );

  const samples = [...new PromptfooSamples(rows, readers)];

  assert.ok(
    rows.filter((row) => row.vars['q'] === 'b').length > 1,
    'afterAll of the retry got the stale row of b beside its retried row',
  );
  assert.deepEqual(
    samples.map(({ test, epoch, outcome }) => [test, epoch, outcome]),
    [
      ['a', 0, 'answered'],
      ['a', 1, 'answered'],
      ['b', 0, 'answered'],
      ['b', 1, 'answered'],
    ],
  );
});

// The second form of a failed call (ADR 0005): an afterEach hook grades each
// error row on the answer null and copies its named scores, as SOB's
// failed-answer.ts of offers-evals does. A test adds its afterAll.
const gradingHook = `import { writeFileSync } from 'node:fs';
import { ResultFailureReason, assertions } from '${import.meta.resolve('promptfoo')}';
import { FailedCall } from '${new URL('./index.ts', import.meta.url).href}';

export async function afterEach({ test, result }) {
  if (result.failureReason !== ResultFailureReason.ERROR) return;
  const graded = await assertions.runAssertions({
    test,
    providerResponse: { output: FailedCall.answer },
    vars: test.vars,
  });
  Object.assign(result.namedScores, graded.namedScores);
}
`;

test('an error row that an afterEach hook graded is a failed sample with its error and its scores, each of the weight 1 that promptfoo gives it', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  await writeFile(join(folder.path, 'extension.ts'), gradingHook);
  const exported = await evaluate(folder.path, {
    callApi: `if (prompt === 'b') return { error: '503 Service Unavailable' };
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1, b: 2 } },
    ],
    extensions: ['file://extension.ts:afterEach'],
  });

  const samples = [...new PromptfooSamples(exported.results.results, readers)];

  assert.deepEqual(
    samples.map((sample) => ({
      test: sample.test,
      outcome: sample.outcome,
      answer: sample.answer,
      error: sample.outcome === 'failed' ? sample.error : undefined,
      ratios: sample.scorecard.ratios,
    })),
    [
      {
        test: 'a',
        outcome: 'answered',
        answer: '{"a": 1}',
        error: undefined,
        ratios: new Map([['recall', new Ratio(1, 1)]]),
      },
      {
        test: 'b',
        outcome: 'failed',
        answer: null,
        error: '503 Service Unavailable',
        // The answer null states none of the two values, and promptfoo
        // weighs the score of the hook 1, not 2.
        ratios: new Map([['recall', new Ratio(0, 1)]]),
      },
    ],
  );
  const [prompt] = exported.results.prompts;
  assert.ok(prompt);
  assert.equal(
    (prompt.metrics.namedScores['recall'] ?? Number.NaN) /
      (prompt.metrics.namedScoreWeights['recall'] ?? Number.NaN),
    1 / 2,
  );
});

test('after --retry-errors, the graded error row of a failed call gives way to the row of the call that answered', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  await writeFile(
    join(folder.path, 'extension.ts'),
    `${gradingHook}
export async function afterAll(context) {
  writeFileSync('after-all.json', JSON.stringify(context.results));
}
`,
  );
  // The call of b fails while the file "fail" exists, as a 503 would.
  await writeFile(join(folder.path, 'fail'), '');
  const run = {
    callApi: `const { existsSync } = await import('node:fs');
    if (prompt === 'b' && existsSync('fail')) return { error: '503 Service Unavailable' };
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
    extensions: [
      'file://extension.ts:afterEach',
      'file://extension.ts:afterAll',
    ],
  };
  await evaluate(folder.path, run);
  await rm(join(folder.path, 'fail'));
  await evaluate(folder.path, { ...run, args: ['--retry-errors'] });
  const rows: PromptfooResult[] = JSON.parse(
    await readFile(join(folder.path, 'after-all.json'), 'utf8'),
  );

  const samples = [...new PromptfooSamples(rows, readers)];

  assert.ok(
    rows.some(
      (row) =>
        row.vars['q'] === 'b' &&
        row.failureReason === ResultFailureReason.ERROR &&
        row.namedScores['recall'] === 0,
    ),
    'afterAll of the retry got the graded error row of b beside its retried row',
  );
  assert.deepEqual(
    samples.map(({ test, outcome, scorecard }) => [
      test,
      outcome,
      scorecard.ratios,
    ]),
    [
      ['a', 'answered', new Map([['recall', new Ratio(1, 1)]])],
      ['b', 'answered', new Map([['recall', new Ratio(1, 1)]])],
    ],
  );
});

test('the rows that promptfoo hands an afterAll extension, an answered row and a graded error row, are its samples as they are', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  // afterAll reads context.results as promptfoo holds them, before JSON
  // drops a key whose value is undefined.
  await writeFile(
    join(folder.path, 'extension.ts'),
    `${gradingHook}
import { PromptfooSamples } from '${new URL('./index.ts', import.meta.url).href}';

export async function afterAll(context) {
  const samples = new PromptfooSamples(context.results, {
    test: (result) => String(result.vars.q),
    cases: { from: (vars) => ({ expected: vars.expected, weight: 1 }) },
    answer: (output) => output,
  });
  writeFileSync(
    'samples.json',
    JSON.stringify({
      undefinedErrors: context.results.filter(
        (result) => Object.hasOwn(result, 'error') && result.error === undefined,
      ).length,
      samples: [...samples].map((sample) => ({
        test: sample.test,
        outcome: sample.outcome,
        answer: sample.answer,
        error: sample.outcome === 'failed' ? sample.error : null,
        ratios: [...sample.scorecard.ratios].map(([name, { part, whole }]) => [name, part, whole]),
      })),
    }),
  );
}
`,
  );
  await evaluate(folder.path, {
    callApi: `if (prompt === 'b') return { error: '503 Service Unavailable' };
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1, b: 2 } },
    ],
    extensions: [
      'file://extension.ts:afterEach',
      'file://extension.ts:afterAll',
    ],
  });

  const written: unknown = JSON.parse(
    await readFile(join(folder.path, 'samples.json'), 'utf8'),
  );

  assert.deepEqual(written, {
    // The answered row of a holds the key error with the value undefined.
    undefinedErrors: 1,
    samples: [
      {
        test: 'a',
        outcome: 'answered',
        answer: '{"a": 1}',
        error: null,
        ratios: [['recall', 1, 1]],
      },
      {
        test: 'b',
        outcome: 'failed',
        answer: null,
        error: '503 Service Unavailable',
        ratios: [['recall', 0, 1]],
      },
    ],
  });
});

test("promptfoo's own rows, of evaluate and of an afterAll extension, are the input of the samples", () => {
  // typecheck proves this test: promptfoo's types, under
  // exactOptionalPropertyTypes, must be assignable with no cast, and a reader
  // reads the test's description, promptfoo's own test id.
  const described: PromptfooReaders<
    unknown,
    { readonly expected: unknown; readonly weight: number }
  > = { ...readers, test: (result) => result.testCase.description ?? '' };
  const inputs = [
    (results: EvaluateResult[]) => new PromptfooSamples(results, readers),
    (context: AfterAllExtensionHookContext) =>
      new PromptfooSamples(context.results, readers),
    (results: EvaluateResult[]) => new PromptfooSamples(results, described),
  ];

  assert.equal(inputs.length, 3);
});

// The guards below read rows that promptfoo does not write for one run, so
// each test builds them from a row that promptfoo wrote.

test('two rows of one test that are not errors are refused, since promptfoo does not tell which is the newest', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  assert.throws(() => new PromptfooSamples([row, { ...row }], readers), {
    name: 'RangeError',
    message:
      'Test 0 (epoch 0) has 2 rows, and promptfoo does not tell which is the newest',
  });
});

test('two error rows of one test with other scores are refused, since promptfoo does not tell which is the newest', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `throw new Error('503 Service Unavailable');`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  assert.throws(
    () =>
      new PromptfooSamples(
        [row, { ...row, namedScores: { recall: 0.5 } }],
        readers,
      ),
    {
      name: 'RangeError',
      message:
        'Test 0 (epoch 0) has 2 rows, and promptfoo does not tell which is the newest',
    },
  );
});

test('a graded error row with no error is refused, since promptfoo writes the error of each error row', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  await writeFile(join(folder.path, 'extension.ts'), gradingHook);
  const exported = await evaluate(folder.path, {
    callApi: `return { error: '503 Service Unavailable' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
    extensions: ['file://extension.ts:afterEach'],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  assert.throws(
    () => new PromptfooSamples([{ ...row, error: null }], readers),
    { name: 'RangeError', message: 'The error row of test a has no error' },
  );
});

test('a score with no weight is refused, since promptfoo writes the weight of each score', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });
  const [row] = exported.results.results;
  assert.ok(row?.gradingResult);
  const unweighted = {
    ...row,
    gradingResult: { ...row.gradingResult, namedScoreWeights: {} },
  };

  assert.throws(() => new PromptfooSamples([unweighted], readers), {
    name: 'RangeError',
    message: 'Score recall of test a has no weight in namedScoreWeights',
  });
});
