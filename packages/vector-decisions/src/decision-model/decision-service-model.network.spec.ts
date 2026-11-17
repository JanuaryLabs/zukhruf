import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  type Experimental_DecisionAnswer,
  type Experimental_DecisionQuestion,
  type Experimental_DecisionState,
  experimental_decide,
} from 'ai';
import type { MockEmbeddingModelV4 } from 'ai/test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import { DecisionService, DecisionServiceModel } from '../index.ts';
import {
  assertClose,
  goldenReader,
  goldenService,
} from '../testing/venn-golden.ts';

// The tests need the venn-1 head, which the repository does not ship, so
// they download it into the cache of Hugging Face.

// Venn computes the probabilities in float32, and the package in float64:
// the answers of the fixture differ by at most 5.2e-8 of max(1, |Venn's|)
// (measured 2026-11-14).
const TOLERANCE = 1e-7;

type Call = {
  readonly state: Experimental_DecisionState;
  readonly questions: Readonly<Record<string, Experimental_DecisionQuestion>>;
};

type Answered = {
  readonly call: Call;
  readonly answers: Readonly<
    Record<string, Experimental_DecisionAnswer<Experimental_DecisionQuestion>>
  >;
  readonly noneProbability: Readonly<Record<string, number>>;
};

// The raw vector of each text that Venn embedded, and the calls of
// experimental_decide that Venn's own Decisions API, venn.decisions.decide,
// answers or refuses (fixtures/generate.py). The answers are in the form of
// the AI SDK.
const golden: {
  readonly raw: Readonly<Record<string, readonly number[]>>;
  readonly answered: Readonly<
    Record<
      | 'kinds'
      | 'boolean criteria'
      | 'null criterion'
      | 'abstention named none'
      | 'tie'
      | 'json'
      | 'text parts'
      | 'parts'
      | 'none text'
      | 'one text',
      Answered
    >
  >;
  readonly refused: readonly {
    readonly call: Call;
    readonly code: string;
    readonly status: number;
  }[];
} = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
);

// The reader that Venn's service had.
function fixtureReader(): MockEmbeddingModelV4 {
  return goldenReader(golden.raw);
}

// A service whose calibrations file is in `registryDirectory`: with no file
// there, each question divides by choice_temperature.
async function service(
  registryDirectory: string,
  database: DatabaseSync,
  reader = fixtureReader(),
): Promise<DecisionService> {
  return goldenService({
    registryPath: join(registryDirectory, 'calibrations.json'),
    database,
    model: reader,
  });
}

// Asks the call of a case of the fixture, and compares the answer to the
// question `id`, and its probability of "none", with Venn's.
async function assertGolden(
  model: DecisionServiceModel,
  answered: Answered,
  id: string,
): Promise<void> {
  const { answers, providerMetadata } = await experimental_decide({
    model,
    ...answered.call,
  });
  assertClose(answers[id], answered.answers[id], `answers.${id}`, TOLERANCE);
  assertClose(
    providerMetadata?.vectorDecisions?.noneProbability,
    answered.noneProbability,
    'providerMetadata.vectorDecisions.noneProbability',
    TOLERANCE,
  );
}

test('experimental_decide refuses a box question before the reader embeds a text', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const reader = fixtureReader();
  const model = new DecisionServiceModel(
    await service(directory.path, database, reader),
  );

  await assert.rejects(
    experimental_decide({
      model,
      state: 'The checkout page is broken and my card was charged twice',
      questions: {
        team: {
          type: 'choice',
          instructions: 'Who owns this ticket?',
          criteria: {
            login: 'Login problems',
            checkout: 'Checkout and payments',
          },
        },
        product: { type: 'box', instructions: 'The broken page' },
      },
    }),
    {
      name: 'AI_DecisionUnsupportedQuestionTypeError',
      questionId: 'product',
      questionType: 'box',
    },
  );
  assert.deepEqual(reader.doEmbedCalls, []);
});

test('doDecide refuses a box question with the error of the AI SDK, also when experimental_decide does not check the types first', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assert.rejects(
    Promise.resolve(
      model.doDecide({
        state: [{ type: 'text', text: 'The checkout page is broken' }],
        questions: {
          product: { type: 'box', instructions: 'The broken page' },
        },
      }),
    ),
    {
      name: 'AI_DecisionUnsupportedQuestionTypeError',
      questionId: 'product',
      questionType: 'box',
      provider: 'vector-decisions.decision',
      modelId: 'venn-1',
    },
  );
});

test('a file part of the state is refused, as Venn refuses media parts, before the reader embeds a text', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const reader = fixtureReader();
  const model = new DecisionServiceModel(
    await service(directory.path, database, reader),
  );

  await assert.rejects(
    experimental_decide({
      model,
      state: [
        {
          type: 'text',
          text: 'The checkout page is broken and my card was charged twice',
        },
        {
          type: 'file',
          mediaType: 'image/png',
          data: new Uint8Array([137, 80, 78, 71]),
        },
      ],
      questions: {
        team: {
          type: 'choice',
          instructions: 'Who owns this ticket?',
          criteria: {
            login: 'Login problems',
            checkout: 'Checkout and payments',
          },
        },
      },
    }),
    {
      name: 'AI_UnsupportedFunctionalityError',
      functionality: 'Decision file input: image/png',
    },
  );
  assert.deepEqual(reader.doEmbedCalls, []);
});

test('a question that Venn refuses, for its instructions or its criteria, is refused with the InvalidArgumentError of the AI SDK for that field', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );
  // The field that each code of Venn refuses. Venn's text of null
  // instructions gives decision_text.
  const fields = new Map([
    ['instructions', 'instructions'],
    ['decision_text', 'instructions'],
    ['criteria', 'criteria'],
  ]);
  const refusals = golden.refused.filter(({ code }) => fields.has(code));

  assert.deepEqual(
    new Set(refusals.map(({ code }) => code)),
    new Set(fields.keys()),
  );
  for (const { call, code } of refusals) {
    const [id = ''] = Object.keys(call.questions);
    await assert.rejects(experimental_decide({ model, ...call }), {
      name: 'AI_InvalidArgumentError',
      parameter: `questions.${id}.${fields.get(code) ?? ''}`,
    });
  }
});

test('a criterion whose description is "none" is refused with the InvalidArgumentError of the AI SDK, until the options have labels of their own (#4389)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assert.rejects(
    experimental_decide({ model, ...golden.answered['none text'].call }),
    { name: 'AI_InvalidArgumentError', parameter: 'questions.team.criteria' },
  );
});

test('two criteria with one description are refused with the InvalidArgumentError of the AI SDK, until the options have labels of their own (#4389)', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assert.rejects(
    experimental_decide({ model, ...golden.answered['one text'].call }),
    { name: 'AI_InvalidArgumentError', parameter: 'questions.team.criteria' },
  );
});

test('a call of more than 32 questions is refused, as Venn refuses one request of them: the questions of a call share one decide', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );
  const refusals = golden.refused.filter(
    ({ code }) => code === 'question_limit',
  );

  assert.ok(refusals.length > 0);
  for (const { call, code, status } of refusals)
    await assert.rejects(experimental_decide({ model, ...call }), {
      name: 'ContractError',
      code,
      status,
    });
});

test('a choice gives the criterion with the largest probability, and the probability of each criterion without "none", as Venn does in a call of three kinds', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered.kinds, 'team');
});

test('a score gives the sum of each probability times its level from zero, and the probability of each level without "none", as Venn does in a call of three kinds', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered.kinds, 'urgency');
});

test('a boolean question without criteria asks "No. " and "Yes. " before its instructions, and gives the probability of true without "none", as Venn does in a call of three kinds', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered.kinds, 'defect');
});

test('a boolean question with descriptions of true and false asks them, as Venn does', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered['boolean criteria'], 'defect');
});

test('a criterion of a choice without a description is the abstention: the probability of "none", after the other criteria, as Venn gives it, also with the name "none"', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered['null criterion'], 'team');
  await assertGolden(model, golden.answered['abstention named none'], 'team');
});

test('of two criteria with the same probability, the first one is the choice, as np.argmax gives it in Venn', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered.tie, 'team');
});

test('JSON instructions, criteria and state are the text that Venn writes for them: sorted keys by code point, ", " and ": ", and a float with an exponent under 1e-4 only', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered.json, 'team');
  await assertGolden(model, golden.answered.json, 'urgency');
});

test('a state of parts is the text of each part, a JSON part as Venn writes its value, with "\\n" between them', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  await assertGolden(model, golden.answered['text parts'], 'team');
  await assertGolden(model, golden.answered.parts, 'team');
});

test('maxOutputTokens and reasoning give warnings of settings that the model does not support, as the AI SDK asks of a native decision model', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  using database = open(join(directory.path, 'cache.sqlite'));
  const model = new DecisionServiceModel(
    await service(directory.path, database),
  );

  const { warnings } = await experimental_decide({
    model,
    ...golden.answered.kinds.call,
    maxOutputTokens: 16,
    reasoning: 'low',
  });
  const { warnings: none } = await experimental_decide({
    model,
    ...golden.answered.kinds.call,
  });

  assert.deepEqual(warnings, [
    { type: 'unsupported', feature: 'maxOutputTokens' },
    { type: 'unsupported', feature: 'reasoning' },
  ]);
  assert.deepEqual(none, []);
});

test(
  'a criterion whose description is "none", or two criteria with one description, get the answers of Venn, which asks its own labels option-0, option-1 and so on',
  { todo: '#4389 DecisionService has no port of the vector of Venn' },
  async () => {
    await using directory = await new TemporaryFiles().directory(
      'vector-decisions-',
    );
    using database = open(join(directory.path, 'cache.sqlite'));
    const model = new DecisionServiceModel(
      await service(directory.path, database),
    );

    await assertGolden(model, golden.answered['none text'], 'team');
    await assertGolden(model, golden.answered['one text'], 'team');
  },
);
