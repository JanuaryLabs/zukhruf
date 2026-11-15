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
// in float64: the probabilities of the fixture differ by at most 1.5e-7 (a
// row of IndexApply), and the expected scores by 9.3e-8 of their size
// (measured 2026-11-14).
const TOLERANCE = 3e-7;
// The vector of a text state is the vector of the reader, which src/reader
// compares with Venn's to 2 units in the last place of float32.
const FLOAT32_TOLERANCE = 2 ** -21;

type Answered = {
  readonly request: DecisionRequest;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly vector: Decision['vector'];
};

type Registrable = Parameters<DecisionService['registerQuestion']>[0];

// The raw vectors of a reader, the requests that Venn's own
// DecisionService.decide answers or refuses with them, and the questions that
// its register_question prepares or refuses (fixtures/generate.py). A
// questionRef names a question of "registered". JSON has no NaN, so the
// fixture writes it as "NaN". The types refuse some requests and questions
// that a caller from JavaScript can send: the type Ranking, a state of
// several kinds, and a registered question with a threshold.
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
      | 'noul none'
      | 'index texts'
      | 'index row cap'
      | 'index threshold'
      | 'reference'
      | 'reference rows'
      | 'reference overrides'
      | 'reference rows overrides'
      | 'reference kinds'
      | 'reference rows vectors',
      Answered
    >
  >;
  readonly refused: readonly {
    readonly request: DecisionRequest;
    readonly code: ContractErrorCode;
    readonly status: number;
  }[];
  readonly registered: Readonly<Record<string, Registrable>>;
  readonly handles: readonly {
    readonly name: string;
    readonly questions: readonly [Registrable, Registrable];
    readonly same: boolean;
  }[];
  readonly 'refused registrations': readonly {
    readonly question: Registrable;
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

// A service whose calibrations file is in `registryDirectory`: with no file there,
// each question divides by choice_temperature.
async function service(
  registryDirectory: string,
  database: DatabaseSync,
  model = venn(),
): Promise<DecisionService> {
  return DecisionService.load({
    model,
    database,
    directory: await downloadHead(),
    registryPath: join(registryDirectory, 'calibrations.json'),
  });
}

// The requests that Venn refuses with the code, of which there is at least
// one.
function refused(code: ContractErrorCode) {
  const requests = golden.refused.filter((request) => request.code === code);
  assert.ok(requests.length > 0, `The fixture has no request for ${code}`);
  return requests;
}

// The handle that registerQuestion of the service gives for each registered
// question of the fixture, by its name.
async function register(
  decisions: DecisionService,
): Promise<ReadonlyMap<string, string>> {
  const handles = new Map<string, string>();
  for (const [name, question] of Object.entries(golden.registered))
    handles.set(name, await decisions.registerQuestion(question));
  return handles;
}

// The request with the handle of each questionRef that names a registered
// question, as generate.py gives Venn its own handles.
function referenced(
  request: DecisionRequest,
  handles: ReadonlyMap<string, string>,
): DecisionRequest {
  return {
    ...request,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => [
        name,
        question.questionRef === undefined
          ? question
          : {
              ...question,
              questionRef:
                handles.get(question.questionRef) ?? question.questionRef,
            },
      ]),
    ),
  };
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
    DecisionService.load({
      model: venn(),
      database,
      directory: copy.path,
      registryPath: join(directory.path, 'calibrations.json'),
    });
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
  const decisions = await service(directory.path, database);

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
  const decisions = await service(directory.path, database);

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
  const decisions = await service(directory.path, database);

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
  const decisions = await service(directory.path, database);

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
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('rubric'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('invalid_text: an empty text, or a text of more than 32,768 characters, is refused, also as a row of a plural state, and a character is a code point, as Python counts it', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  // 32,768 code points, which are 65,536 code units of JavaScript.
  const longest = '😀'.repeat(32_768);
  const decisions = await service(
    directory.path,
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

test('invalid_vector: a vector of another width than the head reads, or with a value that is not finite, is refused, also as a row of a plural state, and a plural state of no vectors', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('invalid_vector'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('zero_vector: a vector of norm 0 is refused, also as a row of a plural state', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('zero_vector'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('unsupported_input: a plural state, of texts or of vectors, is refused for Choice, Score and Noul, which answer one state', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

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
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('question_type'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('state_texts: a state of no texts, or of more than 512, is refused, and the texts are counted before the kinds of the state', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('state_texts'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('state_limit: a state of more than 512 vectors is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('state_limit'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('state_shape: a state of texts that also has a text, a vector or vectors is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('state_shape'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('index_input: an IndexApply question about one state, a text or a vector, is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('index_input'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('stream_limit: a rowCap that is not a whole number from 0 to 1,000,000, or a batchSize that is not a whole number from 1 to 65,536, is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('stream_limit'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('stream_required: a rowCap of more than 512 is refused with the status 413, as decide answers at most 512 rows', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { request, code, status } of refused('stream_required'))
    await assert.rejects(decisions.decide(request), {
      name: 'ContractError',
      code,
      status,
    });
});

test('question_handle: a questionRef that registerQuestion did not give is refused with the status 404', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  for (const { request, code, status } of refused('question_handle'))
    await assert.rejects(decisions.decide(referenced(request, handles)), {
      name: 'ContractError',
      code,
      status,
    });
});

test('prewarm_override: a questionRef that also gives options, instructions or a type is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  for (const { request, code, status } of refused('prewarm_override'))
    await assert.rejects(decisions.decide(referenced(request, handles)), {
      name: 'ContractError',
      code,
      status,
    });
});

test('prewarm_type: registerQuestion refuses a question of another type than Choice, Score, Noul or IndexApply', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const refusals = golden['refused registrations'].filter(
    ({ code }) => code === 'prewarm_type',
  );

  assert.ok(refusals.length > 0);
  for (const { question, code, status } of refusals)
    await assert.rejects(decisions.registerQuestion(question), {
      name: 'ContractError',
      code,
      status,
    });
});

test('registerQuestion refuses instructions and options as decide refuses them', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const refusals = golden['refused registrations'].filter(
    ({ code }) => code !== 'prewarm_type',
  );

  assert.deepEqual(
    new Set(refusals.map(({ code }) => code)),
    new Set([
      'option_limit',
      'option_labels',
      'invalid_text',
      'invalid_vector',
    ]),
  );
  for (const { question, code, status } of refusals)
    await assert.rejects(decisions.registerQuestion(question), {
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
  const decisions = await service(directory.path, database);
  const { kinds } = golden.answered;

  const decision = await decisions.decide(kinds.request);

  assertAnswer(decision, kinds, 'team');
});

test('a Score question also gives the expected score of the options, with the levels 0, 1, 2 and so on, or the scores that it gives', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const { kinds, scores } = golden.answered;

  for (const answered of [kinds, scores])
    assertAnswer(await decisions.decide(answered.request), answered, 'urgency');
});

test('a Noul question gives the probability of "none" first, shares the rest among the options, and answers "none" from the threshold, or 0.5, up, else "in_scope"', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
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
  const decisions = await service(directory.path, database);
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
  const decisions = await service(directory.path, database);
  const { defaults } = golden.answered;

  assertAnswer(await decisions.decide(defaults.request), defaults, 'topic');
});

test('a request can give the vectors: a state vector that is not a unit vector, instructionsVec, and an option as a label with its vector', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const { given } = golden.answered;

  assertAnswer(await decisions.decide(given.request), given, 'team');
});

test('the decision gives the vector of a state that the reader embedded, the vectors of a state of texts, and null for given vectors', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const { kinds, thresholds, given } = golden.answered;
  const texts = golden.answered['index texts'];
  const vectors = golden.answered['index threshold'];

  for (const answered of [kinds, thresholds, texts]) {
    const { vector } = await decisions.decide(answered.request);
    assert.ok(vector !== null && answered.vector !== null);
    const values = answered.vector.flat();
    const got = vector.flat();
    assert.equal(got.length, values.length);
    for (const [index, value] of values.entries()) {
      const number = got[index] ?? Number.NaN;
      assert.ok(
        Math.abs(number - value) <= FLOAT32_TOLERANCE * Math.abs(value),
        `value ${index}: ${number} against Venn's ${value}`,
      );
    }
  }
  assert.ok(Array.isArray(texts.vector?.[0]));
  for (const answered of [given, vectors]) {
    assert.equal((await decisions.decide(answered.request)).vector, null);
    assert.equal(answered.vector, null);
  }
});

test('a request of several named questions of each type answers each by its name about the one state', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const { kinds } = golden.answered;

  const { answers } = await decisions.decide(kinds.request);

  assertClose(answers, kinds.answers, 'answers');
});

test('of two options with the same probability, the first one is the answer', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const { tie } = golden.answered;

  assertAnswer(await decisions.decide(tie.request), tie, 'team');
});

test('an option that is only a label is the text of its label', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const { labels } = golden.answered;

  assertAnswer(await decisions.decide(labels.request), labels, 'team');
});

test('an IndexApply question answers each row of a plural state as a Choice question answers one state, with the index of the row as its id, in one batch', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const indexTexts = golden.answered['index texts'];

  assertAnswer(await decisions.decide(indexTexts.request), indexTexts, 'rows');
});

test('an IndexApply question answers the first rowCap rows, no row for a rowCap of 0, and counts the batches of batchSize rows', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const rowCap = golden.answered['index row cap'];

  const decision = await decisions.decide(rowCap.request);

  assertAnswer(decision, rowCap, 'first');
  assertAnswer(decision, rowCap, 'none');
});

test('an IndexApply question answers "none" for each row whose confidence is below its threshold', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const threshold = golden.answered['index threshold'];

  assertAnswer(await decisions.decide(threshold.request), threshold, 'rows');
});

test('a questionRef answers as the question that registerQuestion registered, of each type, without the threshold of the registration', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const reference = golden.answered['reference'];
  const rows = golden.answered['reference rows'];
  const kinds = golden.answered['reference kinds'];

  assertAnswer(
    await decisions.decide(referenced(reference.request, handles)),
    reference,
    'team',
  );
  assertAnswer(
    await decisions.decide(referenced(rows.request, handles)),
    rows,
    'rows',
  );
  const decision = await decisions.decide(referenced(kinds.request, handles));
  assertAnswer(decision, kinds, 'urgency');
  assertAnswer(decision, kinds, 'defect');
});

test('a questionRef gives its threshold, and for IndexApply its rowCap and batchSize, to the registered question', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const overrides = golden.answered['reference overrides'];
  const rows = golden.answered['reference rows overrides'];
  // Rows of given vectors that are not unit vectors.
  const vectors = golden.answered['reference rows vectors'];

  assertAnswer(
    await decisions.decide(referenced(overrides.request, handles)),
    overrides,
    'team',
  );
  assertAnswer(
    await decisions.decide(referenced(rows.request, handles)),
    rows,
    'rows',
  );
  assertAnswer(
    await decisions.decide(referenced(vectors.request, handles)),
    vectors,
    'rows',
  );
});

test('the handle of registerQuestion names the question without its threshold: the same question, with its keys in another order or another threshold, gets the same handle, and another question another handle', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const {
    name,
    questions: [first, second],
    same,
  } of golden.handles)
    assert.equal(
      (await decisions.registerQuestion(first)) ===
        (await decisions.registerQuestion(second)),
      same,
      name,
    );
});

test('the type of registerQuestion refuses a threshold, which no decision reads, and registerQuestion drops one that JavaScript gives', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const team = {
    instructions: 'Who owns this ticket?',
    options: ['Login problems', 'Checkout and payments'],
  };

  const handle = await decisions.registerQuestion(team);
  const thresholded = await decisions.registerQuestion({
    ...team,
    // @ts-expect-error Each decision gives the threshold (ADR 0004).
    threshold: 0.9,
  });

  assert.equal(thresholded, handle);
});

test('registerQuestion embeds the texts of the question, so a decision with its handle about a given vector makes no model call', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = venn();
  const decisions = await service(directory.path, database, model);
  const handle = await decisions.registerQuestion({
    instructions: 'Who owns this ticket?',
    options: ['Login problems', 'Checkout and payments'],
  });
  const calls = model.doEmbedCalls.length;

  await decisions.decide({
    state: { vector: golden.raw['Login problems'] ?? [] },
    questions: { team: { questionRef: handle } },
  });

  assert.ok(calls > 0);
  assert.equal(model.doEmbedCalls.length, calls);
});

test('a second decision of the same request gives the same answers, and the vector cache makes no model call', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = venn();
  const decisions = await service(directory.path, database, model);
  const { kinds } = golden.answered;
  const first = await decisions.decide(kinds.request);
  const calls = model.doEmbedCalls.length;

  const second = await decisions.decide(kinds.request);

  assert.ok(calls > 0);
  assert.equal(model.doEmbedCalls.length, calls);
  assert.deepEqual(second, first);
});
