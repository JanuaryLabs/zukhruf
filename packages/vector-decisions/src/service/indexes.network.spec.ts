import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import type {
  Answer,
  CalibrationKind,
  ContractErrorCode,
  Decision,
  DecisionRequest,
  DecisionService,
  IndexApplyQuestion,
  IndexBatch,
  IndexValue,
  NearestReferenceQuestion,
  State,
  StreamedRef,
} from '../index.ts';
import {
  assertClose,
  goldenReader,
  goldenService,
} from '../testing/venn-golden.ts';

// Venn computes the logits and the probabilities in float32, and the
// package in float64: the rows of IndexApply and of streamIndex differ by at
// most 4.7e-7, on rows near an option, whose probabilities are large
// (measured 2026-11-15).
const TOLERANCE = 5e-7;
// The probability of NearestReference is a float32 number on both sides,
// and the scores of Venn add up in float32: the probabilities differ by at
// most 1.9e-8 and the margins by 1.1e-8 (measured 2026-11-15), within one
// unit in the last place of a float32 from 0.5 to 1.
const NEAREST_TOLERANCE = 2 ** -24;
// The vector of a text state is the vector of the reader, which src/reader
// compares with Venn's to 2 units in the last place of float32.
const FLOAT32_TOLERANCE = 2 ** -21;
// The temperatures of registerCalibration, as the tests of calibration
// compare them.
const TEMPERATURE_TOLERANCE = 1e-9;

type Registration = {
  readonly vectors: readonly (readonly number[])[];
  readonly ids: readonly IndexValue[];
  readonly outcomes: readonly IndexValue[] | null;
};

type Registrable = Parameters<DecisionService['registerQuestion']>[0];

type Answered = {
  readonly request: DecisionRequest;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly vector: Decision['vector'];
};

type Streamed = {
  readonly index: string;
  readonly question: IndexApplyQuestion | StreamedRef;
};

// What Venn's own DecisionService gives (fixtures/indexes/generate.py): the
// indexes that register_index registers, as places in "pool", with Venn's
// handles, the registrations that it refuses, the calibrations, the
// requests that decide answers or refuses, and the calls of stream_index
// with the lines that it yields, or its refusal. An indexRef names an index
// of "indexes", and a questionRef a question of "registered": each side
// puts its own handle there. JSON has no NaN, so the fixture writes it as
// "NaN".
const golden: {
  readonly raw: Readonly<Record<string, readonly number[]>>;
  readonly pool: readonly (readonly number[])[];
  readonly indexes: Readonly<
    Record<
      | 'small'
      | 'labelled'
      | 'unicode'
      | 'integers'
      | 'ties'
      | 'integer ties'
      | 'astral ties'
      | 'near the options'
      | 'one label'
      | 'one mixed label'
      | 'over decide'
      | 'wide',
      {
        readonly rows: readonly number[];
        readonly ids: readonly IndexValue[];
        readonly outcomes: readonly IndexValue[] | null;
        readonly handle: string;
        readonly vectors?: readonly (readonly number[])[];
      }
    >
  >;
  readonly handles: readonly {
    readonly name: string;
    readonly indexes: readonly [Registration, Registration];
    readonly same: boolean;
  }[];
  readonly 'refused indexes': readonly (Registration & {
    readonly code: ContractErrorCode;
    readonly status: number;
  })[];
  readonly 'unknown index': {
    readonly code: ContractErrorCode;
    readonly status: number;
  };
  readonly calibrations: readonly {
    readonly family: string;
    readonly kind: CalibrationKind;
    readonly logits: readonly (readonly number[])[];
    readonly targets: readonly number[];
    readonly temperature: number;
  }[];
  readonly registered: Readonly<Record<string, Registrable>>;
  readonly answered: Readonly<
    Record<
      | 'index rows'
      | 'index row cap'
      | 'index reference'
      | 'index low threshold'
      | 'index row cap 512'
      | 'nearest'
      | 'nearest vector'
      | 'nearest ties'
      | 'nearest family'
      | 'nearest own family'
      | 'nearest threshold',
      Answered
    >
  >;
  readonly refused: readonly {
    readonly request: DecisionRequest;
    readonly code: ContractErrorCode;
    readonly status: number;
  }[];
  readonly streamed: Readonly<
    Record<
      | 'batches'
      | 'one batch'
      | 'wide'
      | 'wide row cap'
      | 'row cap past the rows'
      | 'row cap 0'
      | 'threshold'
      | 'low threshold'
      | 'batch size 65536'
      | 'family'
      | 'reference'
      | 'reference overrides'
      | 'reference family'
      | 'reference low threshold',
      Streamed & { readonly lines: readonly IndexBatch[] }
    >
  >;
  readonly 'refused streams': readonly (Streamed & {
    readonly code: ContractErrorCode;
    readonly status: number;
  })[];
  readonly 'refused registrations': readonly {
    readonly question: Registrable;
    readonly code: ContractErrorCode;
    readonly status: number;
  }[];
} = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/indexes/expected.json'),
    'utf8',
  ),
  (_key, value: unknown) => (value === 'NaN' ? Number.NaN : value),
);

async function service(
  registryDirectory: string,
  database: DatabaseSync,
): Promise<DecisionService> {
  return goldenService({
    registryPath: join(registryDirectory, 'calibrations.json'),
    database,
    model: goldenReader(golden.raw),
  });
}

function rows(places: readonly number[]): (readonly number[])[] {
  return places.map((place) => golden.pool[place] ?? []);
}

// Registers each index of the fixture, as generate.py does, and gives the
// handles of the service by the names of the fixture: of the indexes, and
// of the questions of "registered".
async function register(decisions: DecisionService): Promise<{
  readonly indexes: ReadonlyMap<string, string>;
  readonly questions: ReadonlyMap<string, string>;
}> {
  const indexes = new Map<string, string>();
  for (const [name, index] of Object.entries(golden.indexes))
    indexes.set(
      name,
      decisions.registerIndex(
        rows(index.rows),
        index.ids,
        index.outcomes ?? undefined,
      ),
    );
  const questions = new Map<string, string>();
  for (const [name, question] of Object.entries(golden.registered))
    questions.set(name, await decisions.registerQuestion(question));
  return { indexes, questions };
}

type Handles = Awaited<ReturnType<typeof register>>;

function handle(name: string, handles: Handles): string {
  return handles.indexes.get(name) ?? name;
}

// The request with the handles of the service in place of the names of the
// fixture, as generate.py gives Venn its own handles.
function referenced(
  request: DecisionRequest,
  handles: Handles,
): DecisionRequest {
  return {
    ...request,
    state: referencedState(request.state, handles),
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => {
        if (question.questionRef !== undefined)
          return [
            name,
            {
              ...question,
              questionRef:
                handles.questions.get(question.questionRef) ??
                question.questionRef,
            },
          ];
        if (question.type === 'NearestReference')
          return [
            name,
            { ...question, indexRef: handle(question.indexRef, handles) },
          ];
        return [name, question];
      }),
    ),
  };
}

function referencedState(state: State, handles: Handles): State {
  return typeof state === 'object' && state.indexRef !== undefined
    ? { indexRef: handle(state.indexRef, handles) }
    : state;
}

function referencedStream(
  question: IndexApplyQuestion | StreamedRef,
  handles: Handles,
): IndexApplyQuestion | StreamedRef {
  return question.questionRef === undefined
    ? question
    : {
        ...question,
        questionRef:
          handles.questions.get(question.questionRef) ?? question.questionRef,
      };
}

// Registers the calibrations of the fixture, each within
// TEMPERATURE_TOLERANCE of Venn's temperature.
function calibrate(decisions: DecisionService): void {
  for (const {
    family,
    kind,
    logits,
    targets,
    temperature,
  } of golden.calibrations)
    assertClose(
      decisions.registerCalibration(family, logits, targets, kind),
      temperature,
      `${family}/${kind}`,
      TEMPERATURE_TOLERANCE,
    );
}

// Reads each named stream of the fixture to the end, and compares its batches
// with the lines that Venn yielded.
async function assertStreams(
  decisions: DecisionService,
  handles: Handles,
  names: readonly (keyof typeof golden.streamed)[],
): Promise<void> {
  for (const name of names) {
    const { index, question, lines } = golden.streamed[name];
    const batches = await decisions.streamIndex(
      handle(index, handles),
      referencedStream(question, handles),
    );
    assertClose([...batches], lines, name, TOLERANCE);
  }
}

function refused(code: ContractErrorCode) {
  const requests = golden.refused.filter((request) => request.code === code);
  assert.ok(requests.length > 0, `The fixture has no request for ${code}`);
  return requests;
}

function assertIndexesRefused(
  decisions: DecisionService,
  code: ContractErrorCode,
): void {
  const registrations = golden['refused indexes'].filter(
    (registration) => registration.code === code,
  );
  assert.ok(registrations.length > 0, `The fixture has no index for ${code}`);
  for (const { vectors, ids, outcomes, status } of registrations)
    assert.throws(
      () => decisions.registerIndex(vectors, ids, outcomes ?? undefined),
      { name: 'ContractError', code, status },
    );
}

async function assertDecisionsRefused(
  decisions: DecisionService,
  handles: Handles,
  refusals: readonly {
    readonly request: DecisionRequest;
    readonly code: ContractErrorCode;
    readonly status: number;
  }[],
): Promise<void> {
  for (const { request, code, status } of refusals)
    await assert.rejects(decisions.decide(referenced(request, handles)), {
      name: 'ContractError',
      code,
      status,
    });
}

test('registerIndex refuses a row of another width, a value that is not finite in float32, and no rows, with invalid_vector, before it checks the ids', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  assertIndexesRefused(decisions, 'invalid_vector');
});

test('registerIndex refuses a row of norm 0 with zero_vector, before it checks the ids', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  assertIndexesRefused(decisions, 'zero_vector');
});

test('registerIndex takes more rows than the 512 of decide, and refuses more than 1,000,000 with state_limit', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const over = golden.indexes['over decide'];
  // Venn's check is the same `len > max_rows` as for 513 vectors of decide
  // (venn/server.py:325); 1,000,001 rows of Venn take 3 GB, so the fixture
  // does not hold them. Each row here is one array, given 1,000,001 times.
  const row = golden.pool[0] ?? [];
  const many = Array.from({ length: 1_000_001 }, () => row);

  const handle = decisions.registerIndex(rows(over.rows), over.ids);

  assert.equal(decisions.index(handle).vectors.length, 513);
  assert.throws(
    () =>
      decisions.registerIndex(
        many,
        many.map((_, id) => id),
      ),
    { name: 'ContractError', code: 'state_limit', status: 422 },
  );
});

test('registerIndex refuses ids of another count than the rows, two ids with one str() of Python, and outcomes of another count, with invalid_index', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  assertIndexesRefused(decisions, 'invalid_index');
});

void test.each(
  [
    [[1.5, 2], undefined],
    [[2 ** 53, 2], undefined],
    [
      ['a', 'b'],
      ['p', 0.5],
    ],
    [
      ['a', 'b'],
      ['p', 2 ** 53],
    ],
  ] as const,
  ([ids, outcomes]) =>
    test(`registerIndex refuses an id or an outcome that is a number but not a safe whole number, which Venn takes, with invalid_index (ids ${JSON.stringify(ids)}, outcomes ${JSON.stringify(outcomes)})`, async () => {
      await using directory = await new TemporaryFiles().directory(
        'vector-decisions-',
      );
      using database = open(join(directory.path, 'cache.sqlite'));
      const decisions = await service(directory.path, database);
      const two = rows([0, 1]);

      assert.throws(() => decisions.registerIndex(two, ids, outcomes), {
        name: 'ContractError',
        code: 'invalid_index',
        status: 422,
      });
    }),
);

test("the handle of registerIndex is Venn's: the SHA-256 of the unit float32 rows and of Python's JSON of the ids and the outcomes, also with ids outside ASCII and whole numbers", async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  const handles = await register(decisions);

  for (const [name, index] of Object.entries(golden.indexes))
    assert.equal(handles.indexes.get(name), index.handle, name);
});

test('the same rows and ids get the same handle, also rows two times as long, and other ids, outcomes or rows get another handle, as in Venn', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { name, indexes, same } of golden.handles) {
    const [first, second] = indexes.map(({ vectors, ids, outcomes }) =>
      decisions.registerIndex(vectors, ids, outcomes ?? undefined),
    );
    assert.equal(first === second, same, name);
  }
});

test("index gives the rows as Venn's unit float32 vectors, bit for bit, with the ids and the outcomes, and refuses a handle that registerIndex did not give with index_handle and the status 404", async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const { small, labelled } = golden.indexes;

  const index = decisions.index(handle('small', handles));
  const labelledIndex = decisions.index(handle('labelled', handles));

  assert.deepEqual(
    index.vectors.map((row) => Array.from(row)),
    small.vectors,
  );
  assert.deepEqual(index, { vectors: index.vectors, ids: small.ids });
  assert.deepEqual(labelledIndex, {
    vectors: labelledIndex.vectors,
    ids: labelled.ids,
    outcomes: labelled.outcomes,
  });
  assert.throws(() => decisions.index('unregistered'), {
    name: 'ContractError',
    ...golden['unknown index'],
  });
});

test('decide refuses a state { indexRef } that registerIndex did not give with index_handle and the status 404, after it counts the questions', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  await assertDecisionsRefused(decisions, handles, [
    ...refused('question_limit'),
    ...refused('index_handle').filter(
      ({ request }) => typeof request.state === 'object',
    ),
  ]);
});

void test.each(
  [
    'index rows',
    'index row cap',
    'index reference',
    'index low threshold',
  ] as const,
  (name) =>
    test(`an IndexApply question about an index answers each row with the id of the row, honours rowCap, batchSize, a threshold that turns some rows into "none", also over a questionRef, and the decision has no vector (${name})`, async () => {
      await using directory = await new TemporaryFiles().directory(
        'vector-decisions-',
      );
      using database = open(join(directory.path, 'cache.sqlite'));
      const decisions = await service(directory.path, database);
      const handles = await register(decisions);
      const { request, answers, vector } = golden.answered[name];

      const decision = await decisions.decide(referenced(request, handles));

      assertClose(decision.answers, answers, name, TOLERANCE);
      assert.equal(decision.vector, vector);
    }),
);

test('decide refuses a threshold out of 0..1 that a questionRef gives over its registered question, with threshold', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const overrides = refused('threshold').filter(({ request }) =>
    Object.values(request.questions).some(
      (question) => question.questionRef !== undefined,
    ),
  );

  assert.equal(overrides.length, 1);
  await assertDecisionsRefused(decisions, handles, overrides);
});

test('decide answers at most 512 rows of an index: an index of more rows without a rowCap, or a rowCap of 513, is refused with stream_required and the status 413, and a rowCap of 512 answers', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const capped = golden.answered['index row cap 512'];

  await assertDecisionsRefused(decisions, handles, refused('stream_required'));
  assertClose(
    (await decisions.decide(referenced(capped.request, handles))).answers,
    capped.answers,
    'index row cap 512',
    TOLERANCE,
  );
});

test('a Choice, Score or Noul question about an index is refused with unsupported_input', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  await assertDecisionsRefused(
    decisions,
    handles,
    refused('unsupported_input'),
  );
});

test('streamIndex refuses when it is called, in the order of Venn: the index, the questionRef, rowCap and batchSize, the threshold, then the options and the instructions; and a threshold out of 0..1 over a questionRef', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  assert.deepEqual(
    golden['refused streams'].map(({ code }) => code),
    [
      'index_handle',
      'question_handle',
      ...Array.from({ length: 6 }, () => 'stream_limit'),
      'threshold',
      'threshold',
      'option_limit',
      'option_labels',
      'invalid_text',
      'threshold',
    ],
  );
  for (const { index, question, code, status } of golden['refused streams'])
    await assert.rejects(
      decisions.streamIndex(
        handle(index, handles),
        referencedStream(question, handles),
      ),
      { name: 'ContractError', code, status },
    );
});

test("streamIndex gives a batch of batchSize rows from each offset, the last one shorter, each row answered as a Choice with its id, as Venn's lines; without batchSize or with the largest, 65,536, one batch", async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  await assertStreams(decisions, handles, [
    'batches',
    'one batch',
    'batch size 65536',
  ]);
});

test('streamIndex answers the first rowCap rows: more than the 512 of decide, all the rows for a rowCap past them, and no batch for a rowCap of 0', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);

  await assertStreams(decisions, handles, [
    'wide',
    'wide row cap',
    'row cap past the rows',
    'row cap 0',
  ]);
});

test('streamIndex answers "none" for a row below the threshold, and the option for a row at or above it, and divides by the temperature of the Choice questions of the family', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  calibrate(decisions);

  await assertStreams(decisions, handles, [
    'threshold',
    'low threshold',
    'family',
  ]);
});

test('streamIndex streams the question of a questionRef, with each field of the questionRef over it: the threshold, rowCap, batchSize and the family', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  calibrate(decisions);

  await assertStreams(decisions, handles, [
    'reference',
    'reference overrides',
    'reference family',
    'reference low threshold',
  ]);
});

void test.each(['nearest', 'nearest vector'] as const, (name) =>
  test(`a NearestReference question answers the outcome of the nearest rows, with the margin to the next outcome, its float32 sigmoid over choice_temperature, the ids of the 5 nearest rows, about a text or a given vector, with ids and outcomes outside ASCII or whole numbers (${name})`, async () => {
    await using directory = await new TemporaryFiles().directory(
      'vector-decisions-',
    );
    using database = open(join(directory.path, 'cache.sqlite'));
    const decisions = await service(directory.path, database);
    const handles = await register(decisions);
    const { request, answers, vector } = golden.answered[name];

    const decision = await decisions.decide(referenced(request, handles));

    assertClose(decision.answers, answers, name, NEAREST_TOLERANCE);
    assertClose(decision.vector, vector, `${name}.vector`, FLOAT32_TOLERANCE);
    // Venn's probability is a float32 tensor and its margin a float32 score
    // (venn/server.py:158, 167).
    for (const answer of Object.values(decision.answers)) {
      assert.ok('margin' in answer, name);
      assert.equal(Math.fround(answer.confidence), answer.confidence, name);
      assert.equal(Math.fround(answer.margin), answer.margin, name);
    }
  }),
);

test('of outcomes or rows with the same score, NearestReference answers the later one first, as numpy sorts 16 values or fewer: outcomes by value for whole numbers, else by code point', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const { request, answers } = golden.answered['nearest ties'];

  assertClose(
    (await decisions.decide(referenced(request, handles))).answers,
    answers,
    'nearest ties',
    NEAREST_TOLERANCE,
  );
});

test('a NearestReference question keeps its outcome from a probability equal to its threshold up, and answers "none" below it', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const { request, answers } = golden.answered['nearest threshold'];

  assertClose(
    (await decisions.decide(referenced(request, handles))).answers,
    answers,
    'nearest threshold',
    NEAREST_TOLERANCE,
  );
});

test('a NearestReference question keeps its outcome at a threshold equal to its own probability', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const { state } = golden.answered.nearest.request;
  const question: NearestReferenceQuestion = {
    type: 'NearestReference',
    indexRef: handle('labelled', handles),
  };
  const first = (await decisions.decide({ state, questions: { question } }))
    .answers['question'];
  assert.ok(first !== undefined && 'margin' in first);

  const { answers } = await decisions.decide({
    state,
    questions: { question: { ...question, threshold: first.confidence } },
  });

  const atThreshold = answers['question'];
  assert.ok(atThreshold !== undefined && 'margin' in atThreshold);
  assert.notEqual(first.answer, 'none');
  assert.equal(atThreshold.answer, first.answer);
});

void test.each(['nearest family', 'nearest own family'] as const, (name) =>
  test(`a NearestReference question of a family, its own or the request's, divides its margin by the temperature that registerCalibration fitted for "<family>/NearestReference", which no Choice question reads (${name})`, async () => {
    await using directory = await new TemporaryFiles().directory(
      'vector-decisions-',
    );
    using database = open(join(directory.path, 'cache.sqlite'));
    const decisions = await service(directory.path, database);
    const handles = await register(decisions);
    calibrate(decisions);
    const { request, answers } = golden.answered[name];

    assertClose(
      (await decisions.decide(referenced(request, handles))).answers,
      answers,
      name,
      NEAREST_TOLERANCE,
    );
  }),
);

test('a NearestReference question is refused in the order of Venn: the threshold, the index (index_handle, 404), an index without outcomes or a state that is not one vector (nearest_input), one outcome (nearest_labels), then k (nearest_k)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);
  const handles = await register(decisions);
  const nearest = golden.refused.filter(({ request }) =>
    Object.values(request.questions).some(
      (question) =>
        question.questionRef === undefined &&
        question.type === 'NearestReference',
    ),
  );

  assert.deepEqual(
    [...new Set(nearest.map(({ code }) => code))],
    [
      'threshold',
      'index_handle',
      'nearest_input',
      'nearest_labels',
      'nearest_k',
    ],
  );
  await assertDecisionsRefused(decisions, handles, nearest);
});

test('registerQuestion refuses a NearestReference question, which has no options, with prewarm_type', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(directory.path, database);

  for (const { question, code, status } of golden['refused registrations'])
    await assert.rejects(decisions.registerQuestion(question), {
      name: 'ContractError',
      code,
      status,
    });
});
