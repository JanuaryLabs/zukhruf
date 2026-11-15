import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  type Answer,
  type CalibrationKind,
  type ContractErrorCode,
  type DecisionRequest,
  DecisionService,
} from '../index.ts';
import {
  assertClose,
  goldenReader,
  goldenService,
} from '../testing/venn-golden.ts';

// The tests need the venn-1 head, which the repository does not ship, so
// they download it into the cache of Hugging Face.

// The fit gives Venn's temperatures within 9.1e-11 of their size (measured
// 2026-11-14, "separable rows"); without the float32 rounding of the logits,
// they differ by up to 1.3e-8.
const TEMPERATURE_TOLERANCE = 1e-9;
// The answers of decide, as the tests of DecisionService compare them.
const TOLERANCE = 3e-7;

type Registration = {
  readonly family: string;
  readonly kind: CalibrationKind;
  readonly logits: readonly (readonly number[])[];
  readonly targets: readonly number[];
  readonly temperature: number;
};

type Answered = {
  readonly request: DecisionRequest;
  readonly answers: Readonly<Record<string, Answer>>;
};

// What Venn's own DecisionService gives (fixtures/generate.py): the
// temperatures that register_calibration fits, the registrations that it
// refuses, the calibrations.json that it writes, and the answers of decide
// with those calibrations. A questionRef names a question of "registered".
// "past the bound" holds logits for which Venn's fit stops at e^-5, and the
// temperature of its fit with a clamp that passes the gradient (ADR 0006).
// JSON has no NaN and no infinity, so the fixture writes them as strings.
const golden: {
  readonly raw: Readonly<Record<string, readonly number[]>>;
  readonly fits: readonly {
    readonly name: string;
    readonly logits: readonly (readonly number[])[];
    readonly targets: readonly number[];
    readonly temperature: number;
  }[];
  readonly refused: readonly {
    readonly logits: readonly (readonly number[])[];
    readonly targets: readonly number[];
    readonly code: ContractErrorCode;
    readonly status: number;
  }[];
  readonly registrations: readonly Registration[];
  readonly registry: string;
  readonly deletions: readonly {
    readonly family: string;
    readonly kind: CalibrationKind;
  }[];
  readonly 'registry after deletions': string;
  readonly 'past the bound': {
    readonly logits: readonly (readonly number[])[];
    readonly targets: readonly number[];
    readonly temperature: number;
    readonly 'venn temperature': number;
  };
  readonly registered: Readonly<
    Record<string, Parameters<DecisionService['registerQuestion']>[0]>
  >;
  readonly answered: Readonly<
    Record<
      | 'no family'
      | 'a family'
      | 'a question without a type takes the Choice temperature'
      | 'the family of the request'
      | "the family of the question before the request's"
      | 'a Score'
      | 'a Noul'
      | 'an IndexApply takes the Choice temperature'
      | 'a questionRef'
      | 'a questionRef and the family of the request',
      Answered
    >
  >;
  readonly 'answered after deletions': Readonly<
    Record<'a family' | 'a Noul' | 'a Score', Answered>
  >;
} = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
  (_key, value: unknown) => {
    if (value === 'NaN') return Number.NaN;
    if (value === 'Infinity') return Infinity;
    if (value === '-Infinity') return -Infinity;
    return value;
  },
);

async function service(
  registryPath: string,
  database: DatabaseSync,
): Promise<DecisionService> {
  return goldenService({
    registryPath,
    database,
    model: goldenReader(golden.raw),
  });
}

// The answers of each request, with the handles that registerQuestion of
// the service gives in place of the names of "registered".
async function decideAll(
  decisions: DecisionService,
  requests: Readonly<Record<string, Answered>>,
): Promise<Record<string, Readonly<Record<string, Answer>>>> {
  const handles = new Map<string, string>();
  for (const [name, question] of Object.entries(golden.registered))
    handles.set(name, await decisions.registerQuestion(question));
  const answers: Record<string, Readonly<Record<string, Answer>>> = {};
  for (const [name, { request }] of Object.entries(requests))
    answers[name] = (
      await decisions.decide({
        ...request,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => [
            key,
            question.questionRef === undefined
              ? question
              : {
                  ...question,
                  questionRef:
                    handles.get(question.questionRef) ?? question.questionRef,
                },
          ]),
        ),
      })
    ).answers;
  return answers;
}

// Compares a calibrations.json with Venn's: the same text, but for the
// digits of each temperature, which must be within TEMPERATURE_TOLERANCE.
function assertRegistry(actual: string, venns: string): void {
  const numbers = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?=,?\n)/g;
  assert.equal(actual.replace(numbers, '#'), venns.replace(numbers, '#'));
  assertClose(
    actual.match(numbers)?.map(Number),
    venns.match(numbers)?.map(Number),
    'calibrations.json',
    TEMPERATURE_TOLERANCE,
  );
}

function refused(code: ContractErrorCode) {
  const registrations = golden.refused.filter(
    (registration) => registration.code === code,
  );
  assert.ok(registrations.length > 0, `The fixture has no refusal ${code}`);
  return registrations;
}

test('calibration_size: fewer than 200 or more than 10,000 rows, or another count of targets than of rows, are refused before the values are read', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  for (const { logits, targets, code, status } of refused('calibration_size'))
    assert.throws(() => decisions.registerCalibration('f', logits, targets), {
      name: 'ContractError',
      code,
      status,
    });
});

test('calibration_size: logits whose rows have different lengths are refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );
  const first = golden.registrations[0];
  assert.ok(first !== undefined);
  const { logits, targets } = first;
  const ragged = logits.map((row, index) => (index === 7 ? row.slice(1) : row));

  assert.throws(() => decisions.registerCalibration('f', ragged, targets), {
    name: 'ContractError',
    code: 'calibration_size',
    status: 422,
  });
});

test('calibration_labels: a logit that is not finite in float32, or a target that is not a whole number from 0 to the count of columns, is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  for (const { logits, targets, code, status } of refused('calibration_labels'))
    assert.throws(() => decisions.registerCalibration('f', logits, targets), {
      name: 'ContractError',
      code,
      status,
    });
});

// The write of calibrations.json fails because a directory stands where the
// file goes: no operation of the service makes a write fail.
test('a registration whose write fails throws the error of the write, and decide keeps the temperatures it had', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const registryPath = join(directory.path, 'calibrations.json');
  const decisions = await service(registryPath, database);
  const first = golden.registrations[0];
  assert.ok(first !== undefined);
  const { answers } = await decisions.decide(
    golden.answered['no family'].request,
  );
  await mkdir(registryPath);

  assert.throws(
    () =>
      decisions.registerCalibration(
        first.family,
        first.logits,
        first.targets,
        first.kind,
      ),
    { syscall: 'open', path: registryPath },
  );

  assert.deepEqual(
    (await decisions.decide(golden.answered['no family'].request)).answers,
    answers,
  );
});

test('a deletion whose write fails throws the error of the write, and decide keeps the temperature', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const registryPath = join(directory.path, 'calibrations.json');
  await writeFile(registryPath, golden.registry);
  const decisions = await service(registryPath, database);
  await rm(registryPath);
  await mkdir(registryPath);

  assert.throws(() => decisions.deleteCalibration('tickets'), {
    syscall: 'open',
    path: registryPath,
  });

  const calibrated = golden.answered['a family'];
  assertClose(
    (await decisions.decide(calibrated.request)).answers,
    calibrated.answers,
    'a family',
    TOLERANCE,
  );
});

test('a refused registration changes no temperature, in calibrations.json and in decide', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );
  const first = golden.registrations[0];
  assert.ok(first !== undefined);
  decisions.registerCalibration(
    first.family,
    first.logits,
    first.targets,
    first.kind,
  );
  const registry = await readFile(
    join(directory.path, 'calibrations.json'),
    'utf8',
  );
  const { answers } = await decisions.decide(
    golden.answered['no family'].request,
  );

  for (const { logits, targets } of golden.refused)
    assert.throws(() =>
      decisions.registerCalibration(first.family, logits, targets, first.kind),
    );

  assert.equal(
    await readFile(join(directory.path, 'calibrations.json'), 'utf8'),
    registry,
  );
  assert.deepEqual(
    (await decisions.decide(golden.answered['no family'].request)).answers,
    answers,
  );
});

test("registerCalibration fits the temperature of Venn's fit_temperature to the float32 logits, within the bounds e^-5 and e^5", async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  for (const { name, logits, targets, temperature } of golden.fits)
    assertClose(
      decisions.registerCalibration(name, logits, targets),
      temperature,
      name,
      TEMPERATURE_TOLERANCE,
    );
});

test('registerCalibration finds the best temperature inside the bounds when a step of the fit goes past e^-5, where the fit of Venn stops at e^-5', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );
  const { logits, targets, temperature } = golden['past the bound'];

  const fitted = decisions.registerCalibration('past', logits, targets);

  assertClose(
    fitted,
    temperature,
    'past the bound, the fixed fit',
    TEMPERATURE_TOLERANCE,
  );
});

test('load reads a calibrations.json of Venn, and decide divides the logits of a question by the temperature of its family and its type, or by choice_temperature', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  await writeFile(join(directory.path, 'calibrations.json'), golden.registry);
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  const answers = await decideAll(decisions, golden.answered);

  for (const [name, { answers: expected }] of Object.entries(golden.answered))
    assertClose(answers[name], expected, name, TOLERANCE);
});

test('load throws the error of a read that fails, so a directory at registryPath does not load as an empty registry that the next registration writes over', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const registryPath = join(directory.path, 'calibrations.json');
  await mkdir(registryPath);

  await assert.rejects(service(registryPath, database), { code: 'EISDIR' });
});

test('load refuses a calibrations file that is not JSON, not an object, or holds a temperature that is not a positive finite number, and the error names the file', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const registryPath = join(directory.path, 'calibrations.json');

  for (const text of [
    '{"tickets/Choice": 0.5',
    '[0.5]',
    'null',
    '5',
    '{"tickets/Choice": 0.5, "orders/Choice": 0}',
    '{"tickets/Choice": "0.5"}',
    '{"tickets/Choice": 0}',
    '{"tickets/Choice": -0.5}',
    '{"tickets/Choice": 1e999}',
  ]) {
    await writeFile(registryPath, text);
    await assert.rejects(
      service(registryPath, database),
      (error: unknown) => {
        assert.ok(error instanceof TypeError, text);
        assert.ok(error.message.includes(registryPath), text);
        return true;
      },
      text,
    );
  }
});

test("load reads and writes the calibrations at registryPath, a file of any name, as Venn's registry_path", async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const registryPath = join(directory.path, 'decisions.json');
  await writeFile(registryPath, golden.registry);
  const decisions = await service(registryPath, database);

  const answers = await decideAll(decisions, golden.answered);
  decisions.deleteCalibration('orders');

  for (const [name, { answers: expected }] of Object.entries(golden.answered))
    assertClose(answers[name], expected, name, TOLERANCE);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(registryPath, 'utf8'))),
    Object.keys(JSON.parse(golden.registry)).filter(
      (key) => key !== 'orders/Choice',
    ),
  );
  await assert.rejects(readFile(join(directory.path, 'calibrations.json')), {
    code: 'ENOENT',
  });
});

test('a Noul question divides the "none" part by the temperature of its family and type, and the option part by choice_temperature', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  await writeFile(join(directory.path, 'calibrations.json'), golden.registry);
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );
  const noul = golden.answered['a Noul'];

  const { answers } = await decisions.decide(noul.request);

  assertClose(answers, noul.answers, 'a Noul', TOLERANCE);
});

test("registerCalibration writes calibrations.json as Venn writes it: the temperatures by family and type in Venn's order, and a registration again keeps its place", async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  for (const {
    family,
    kind,
    logits,
    targets,
    temperature,
  } of golden.registrations)
    assertClose(
      decisions.registerCalibration(family, logits, targets, kind),
      temperature,
      `${family}/${kind}`,
      TEMPERATURE_TOLERANCE,
    );

  assertRegistry(
    await readFile(join(directory.path, 'calibrations.json'), 'utf8'),
    golden.registry,
  );
});

test('a registration changes the answers of decide at once, and of a service that loads the registry later', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  for (const { family, kind, logits, targets } of golden.registrations)
    decisions.registerCalibration(family, logits, targets, kind);

  const now = await decideAll(decisions, golden.answered);
  const later = await decideAll(
    await service(join(directory.path, 'calibrations.json'), database),
    golden.answered,
  );
  for (const [name, { answers: expected }] of Object.entries(golden.answered)) {
    assertClose(now[name], expected, `${name} at once`, TOLERANCE);
    assertClose(later[name], expected, `${name} later`, TOLERANCE);
  }
});

test('deleteCalibration removes the temperature of a family and type from calibrations.json and from decide, and the deletion of a temperature that is not there removes nothing', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  await writeFile(join(directory.path, 'calibrations.json'), golden.registry);
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );

  for (const { family, kind } of golden.deletions)
    decisions.deleteCalibration(family, kind);

  assert.equal(
    await readFile(join(directory.path, 'calibrations.json'), 'utf8'),
    golden['registry after deletions'],
  );
  const answers = await decideAll(
    decisions,
    golden['answered after deletions'],
  );
  for (const [name, { answers: expected }] of Object.entries(
    golden['answered after deletions'],
  ))
    assertClose(answers[name], expected, name, TOLERANCE);
});

test('the type of registerCalibration and deleteCalibration is Choice when none is given', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  await writeFile(join(directory.path, 'calibrations.json'), golden.registry);
  const decisions = await service(
    join(directory.path, 'calibrations.json'),
    database,
  );
  const choice = golden.registrations.find(
    ({ family, kind }) => family === 'orders' && kind === 'Choice',
  );
  assert.ok(choice !== undefined);

  decisions.deleteCalibration('tickets');
  const temperature = decisions.registerCalibration(
    'orders',
    choice.logits,
    choice.targets,
  );

  const registry: Record<string, number> = JSON.parse(
    await readFile(join(directory.path, 'calibrations.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(registry), [
    '/Choice',
    'tickets/Score',
    'tickets/Noul',
    'orders/Choice',
  ]);
  assert.equal(registry['orders/Choice'], temperature);
});

test('load makes the directory of registryPath when it is not there, as Venn makes its store', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const registryPath = join(directory.path, 'state', 'calibrations.json');
  const decisions = await service(registryPath, database);
  const first = golden.registrations[0];
  assert.ok(first !== undefined);

  const temperature = decisions.registerCalibration(
    first.family,
    first.logits,
    first.targets,
    first.kind,
  );

  const written: Record<string, number> = JSON.parse(
    await readFile(registryPath, 'utf8'),
  );
  assert.deepEqual(written, { [`${first.family}/${first.kind}`]: temperature });
});
