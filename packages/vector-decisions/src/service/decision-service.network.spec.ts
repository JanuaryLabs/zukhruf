import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  type Answer,
  type ContractErrorCode,
  type Decision,
  type DecisionRequest,
  DecisionService,
  downloadHead,
} from '../index.ts';

// The tests need the venn-1 head, which the repository does not ship, so
// they download it into the cache of Hugging Face.

const PREFIX = 'task: classification | query: ';

// Venn computes the logits and the probabilities in float32, and the package
// in float64: the probabilities of the fixture differ by at most 5.8e-8, and
// the expected scores by 9.3e-8 of their size (measured 2026-11-14).
const TOLERANCE = 3e-7;
// The vector of a text state is the vector of the reader, which src/reader
// compares with Venn's to 2 units in the last place of float32.
const FLOAT32_TOLERANCE = 2 ** -21;

type Answered = {
  readonly request: DecisionRequest;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly vector: readonly number[] | null;
};

// The raw vectors of a reader, and the requests that Venn's own
// DecisionService.decide answers or refuses with them (fixtures/generate.py).
// JSON has no NaN, so the fixture writes it as "NaN". One request has the
// type Ranking, which the types refuse but a caller from JavaScript can send.
const golden: {
  readonly raw: Readonly<Record<string, readonly number[]>>;
  readonly answered: Readonly<
    Record<
      | 'kinds'
      | 'thresholds'
      | 'scores'
      | 'score threshold'
      | 'defaults'
      | 'given'
      | 'tie'
      | 'labels'
      | 'noul in scope'
      | 'noul none',
      Answered
    >
  >;
  readonly refused: readonly {
    readonly request: DecisionRequest;
    readonly code: ContractErrorCode;
    readonly status: number;
  }[];
} = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
  (_key, value: unknown) => (value === 'NaN' ? Number.NaN : value),
);

// The reader that Venn's service had: the raw vector of each text of the
// fixture after the Classification prefix, and no vector for another text.
function venn(
  extra: Readonly<Record<string, readonly number[]>> = {},
): MockEmbeddingModelV4 {
  const rows = new Map(
    Object.entries({ ...golden.raw, ...extra }).map(([text, row]) => [
      `${PREFIX}${text}`,
      row,
    ]),
  );
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: null,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((value) => {
        const row = rows.get(value);
        if (row === undefined)
          throw new Error(`The fixture has no vector for ${value}`);
        return [...row];
      }),
      warnings: [],
    }),
  });
}

async function service(
  database: DatabaseSync,
  model = venn(),
): Promise<DecisionService> {
  return DecisionService.load({
    model,
    database,
    directory: await downloadHead(),
  });
}

// The requests that Venn refuses with the code, of which there is at least
// one.
function refused(code: ContractErrorCode) {
  const requests = golden.refused.filter((request) => request.code === code);
  assert.ok(requests.length > 0, `The fixture has no request for ${code}`);
  return requests;
}

// Compares each number to TOLERANCE of max(1, |Venn's|), and each other
// value exactly.
function assertClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number', `${path} is not a number`);
    assert.ok(
      Math.abs(actual - expected) <=
        TOLERANCE * Math.max(1, Math.abs(expected)),
      `${path}: ${actual} against Venn's ${expected}`,
    );
    return;
  }
  if (typeof expected !== 'object' || expected === null) {
    assert.equal(actual, expected, path);
    return;
  }
  assert.ok(typeof actual === 'object' && actual !== null, path);
  assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
  for (const [key, value] of Object.entries(expected))
    assertClose(Reflect.get(actual, key), value, `${path}.${key}`);
}

// Compares the answer to the question `name` with Venn's answer.
function assertAnswer(
  decision: Decision,
  answered: Answered,
  name: string,
): void {
  const expected = answered.answers[name];
  assert.ok(expected !== undefined, `Venn has no answer to ${name}`);
  assertClose(decision.answers[name], expected, `answers.${name}`);
}

test('load refuses the config.json of a head that reads another reader', async () => {
  await using copy = await new TemporaryFiles().directory(
    'vector-decisions-head-',
  );
  const head = await downloadHead();
  await copyFile(
    join(head, 'universal.safetensors'),
    join(copy.path, 'universal.safetensors'),
  );
  const config: { readonly reader: Readonly<Record<string, unknown>> } =
    JSON.parse(await readFile(join(head, 'config.json'), 'utf8'));
  const manifest: { readonly sha256: Readonly<Record<string, string>> } =
    JSON.parse(await readFile(join(head, 'manifest.json'), 'utf8'));
  // Writes config.json with its SHA-256 in manifest.json, as the publisher
  // of a head does.
  const publish = async (text: string) => {
    await writeFile(join(copy.path, 'config.json'), text);
    await writeFile(
      join(copy.path, 'manifest.json'),
      JSON.stringify({
        sha256: { ...manifest.sha256, 'config.json': hash('sha256', text) },
      }),
    );
  };
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const load = () =>
    DecisionService.load({ model: venn(), database, directory: copy.path });
  // The config of venn-1, published again, loads.
  await publish(JSON.stringify(config));
  await load();

  for (const reader of [
    { ...config.reader, id: 'google/embeddinggemma-300m' },
    { ...config.reader, revision: 'main' },
    { ...config.reader, dimensions: 512 },
  ]) {
    await publish(JSON.stringify({ ...config, reader }));
    await assert.rejects(load(), {
      name: 'InvalidModelArtifactError',
      artifact: 'config.json',
    });
  }
});

test('question_limit: a request with no question, or with more than 32, is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('question_limit'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('option_limit: a question with no option, or with more than 256, is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('option_limit'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('option_labels: two options with one label, or an option with the label "none", are refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('option_labels'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('threshold: a threshold outside 0..1 is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('threshold'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('rubric: a Score question whose scores are not one finite number for each option is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('rubric'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('invalid_text: an empty text, or a text of more than 32,768 characters, is refused, and a character is a code point, as Python counts it', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  // 32,768 code points, which are 65,536 code units of JavaScript.
  const longest = '😀'.repeat(32_768);
  const decisions = await service(
    database,
    venn({ [longest]: Array.from({ length: 768 }, () => 1) }),
  );
  const team = {
    instructions: 'Who owns this ticket?',
    options: ['Login problems', 'Checkout and payments'],
  };

  for (const { request, code, status } of refused('invalid_text'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
  await decisions.decide({ state: longest, questions: { team } });
  await assert.rejects(
    decisions.decide({ state: `${longest}😀`, questions: { team } }),
    { name: 'ContractError', code: 'invalid_text' },
  );
});

test('invalid_vector: a vector of another width than the head reads, or with a value that is not finite, is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('invalid_vector'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('zero_vector: a vector of norm 0 is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('zero_vector'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('unsupported_input: a state of several texts is refused, as Choice, Score and Noul answer one state', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('unsupported_input'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('question_type: a question of another type than Choice, Score or Noul is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);

  for (const { request, code, status } of refused('question_type'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('a Choice question gives the probability of each option and of "none", and the most probable as its answer', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { kinds } = golden.answered;

  const decision = await decisions.decide(kinds.request);

  assertAnswer(decision, kinds, 'team');
});

test('a Score question also gives the expected score of the options, with the levels 0, 1, 2 and so on, or the scores that it gives', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { kinds, scores } = golden.answered;

  for (const answered of [kinds, scores])
    assertAnswer(await decisions.decide(answered.request), answered, 'urgency');
});

test('a Noul question gives the probability of "none" first, shares the rest among the options, and answers "none" from the threshold, or 0.5, up, else "in_scope"', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { kinds, thresholds } = golden.answered;
  // Without a threshold, a probability of "none" of 0.221 and of 0.509.
  const inScope = golden.answered['noul in scope'];
  const none = golden.answered['noul none'];

  for (const answered of [kinds, thresholds, inScope, none])
    assertAnswer(await decisions.decide(answered.request), answered, 'defect');
});

test('a Choice or Score question answers "none" when its confidence is below its threshold', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { thresholds } = golden.answered;
  const scoreThreshold = golden.answered['score threshold'];

  assertAnswer(await decisions.decide(thresholds.request), thresholds, 'team');
  assertAnswer(
    await decisions.decide(scoreThreshold.request),
    scoreThreshold,
    'urgency',
  );
});

test('a question without a type is a Choice, and without instructions asks "What is the topic?"', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { defaults } = golden.answered;

  assertAnswer(await decisions.decide(defaults.request), defaults, 'topic');
});

test('a request can give the vectors: a state vector that is not a unit vector, instructionsVec, and an option as a label with its vector', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { given } = golden.answered;

  assertAnswer(await decisions.decide(given.request), given, 'team');
});

test('the decision gives the vector of a state that the reader embedded, and null for a given vector', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { kinds, thresholds, given } = golden.answered;

  for (const answered of [kinds, thresholds]) {
    const { vector } = await decisions.decide(answered.request);
    assert.ok(vector !== null && answered.vector !== null);
    assert.equal(vector.length, answered.vector.length);
    for (const [index, value] of answered.vector.entries()) {
      const got: number = vector[index] ?? Number.NaN;
      assert.ok(
        Math.abs(got - value) <= FLOAT32_TOLERANCE * Math.abs(value),
        `value ${index}: ${got} against Venn's ${value}`,
      );
    }
  }
  assert.equal((await decisions.decide(given.request)).vector, null);
  assert.equal(given.vector, null);
});

test('a request of several named questions of each type answers each by its name about the one state', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { kinds } = golden.answered;

  const { answers } = await decisions.decide(kinds.request);

  assertClose(answers, kinds.answers, 'answers');
});

test('of two options with the same probability, the first one is the answer', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { tie } = golden.answered;

  assertAnswer(await decisions.decide(tie.request), tie, 'team');
});

test('an option that is only a label is the text of its label', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(database);
  const { labels } = golden.answered;

  assertAnswer(await decisions.decide(labels.request), labels, 'team');
});

test('a second decision of the same request gives the same answers, and the vector cache makes no model call', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = venn();
  const decisions = await service(database, model);
  const { kinds } = golden.answered;
  const first = await decisions.decide(kinds.request);
  const calls = model.doEmbedCalls.length;

  const second = await decisions.decide(kinds.request);

  assert.ok(calls > 0);
  assert.equal(model.doEmbedCalls.length, calls);
  assert.deepEqual(second, first);
});
