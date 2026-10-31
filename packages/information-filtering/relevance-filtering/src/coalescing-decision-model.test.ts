import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type Experimental_DecisionModel,
  type Experimental_DecisionQuestion,
  Experimental_DecisionRefusalError,
  experimental_decide,
} from 'ai';

import {
  CoalescingDecisionModel,
  DecisionScorer,
  type Scores,
  type Stream,
} from './index.ts';

// The decision model of the provider interface, which the decorator wraps.
type DecisionModel = ConstructorParameters<typeof CoalescingDecisionModel>[0];

// A signal that no test aborts.
const running = new AbortController().signal;

// One call that reached the inner model.
type Call = {
  readonly texts: readonly string[];
  readonly questions: Readonly<Record<string, Experimental_DecisionQuestion>>;
  readonly abortSignal: AbortSignal | undefined;
  readonly maxOutputTokens: number | undefined;
};

// No decision model can run in a test, and ai/test has no mock decision
// model. This stand-in is a decision model of the provider interface, under
// the real experimental_decide, as in decision-scorer.test.ts. It answers
// each boolean question of a call from the probability that the test gives
// for the instructions and the text, so a question under a wrong id, or about
// another text, fails. It records each call. A test can hold a call, or fail
// it, with `answer`, which gets the signal of the call.
function model(
  probabilities: ReadonlyMap<string, ReadonlyMap<string, number | 'refusal'>>,
  calls: Call[],
  answer: (
    abortSignal: AbortSignal | undefined,
  ) => Promise<void> = async () => {},
): DecisionModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'decision-stand-in',
    supportedQuestionTypes: ['boolean'],
    doDecide: async ({ state, questions, abortSignal, maxOutputTokens }) => {
      const texts = state.map((part) =>
        part.type === 'text' ? part.text : JSON.stringify(part),
      );
      calls.push({ texts, questions, abortSignal, maxOutputTokens });
      const [text] = texts;
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          const probability = probabilities
            .get(String(question.instructions))
            ?.get(text ?? '');
          if (probability === undefined)
            throw new Error(`The test has no answer for ${id} about ${text}.`);
          return [
            id,
            probability === 'refusal'
              ? { type: 'refusal' as const }
              : { type: 'boolean' as const, probability },
          ];
        }),
      );
      await answer(abortSignal);
      return {
        answers,
        usage: { inputTokens: 40, outputTokens: 2 },
        warnings: [],
      };
    },
  };
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 9, n));
}

const STREAM: Stream = new Map([
  [
    'gpu',
    { publishedAt: day(10), text: 'Nvidia shows its next AI accelerator' },
  ],
  [
    'phishing',
    { publishedAt: day(10), text: 'Phishing kits copy bank logins' },
  ],
  ['fab', { publishedAt: day(11), text: 'TSMC makes 2 nm chips in Arizona' }],
  [
    'earnings',
    { publishedAt: day(11), text: 'Cloud company beats its forecast' },
  ],
]);

const CHIPS =
  'New computer chips and AI hardware, and how chips are made and supplied.';
const SECURITY =
  'Cybersecurity: attacks, breaches, vulnerabilities and the tools that defend against them.';
const question = (description: string) =>
  `Is the main subject of this article: ${description}?`;

const PROBABILITIES = new Map([
  [
    question(CHIPS),
    new Map([
      ['Nvidia shows its next AI accelerator', 0.9],
      ['Phishing kits copy bank logins', 0.05],
      ['TSMC makes 2 nm chips in Arizona', 0.92],
      ['Cloud company beats its forecast', 0.1],
    ]),
  ],
  [
    question(SECURITY),
    new Map([
      ['Nvidia shows its next AI accelerator', 0.2],
      ['Phishing kits copy bank logins', 0.95],
      ['TSMC makes 2 nm chips in Arizona', 0.2],
      ['Cloud company beats its forecast', 0.3],
    ]),
  ],
]);

// What a reader reads of the scores: the ranking and each probability.
function read(scores: Scores) {
  return scores.ranked().map((id) => [id, scores.probability(id)]);
}

// Two experimental_decide calls with one boolean question each, about one
// text, started together.
function ask(
  decisionModel: Experimental_DecisionModel,
  signals: readonly [AbortSignal, AbortSignal],
) {
  return signals.map((abortSignal, n) =>
    experimental_decide({
      model: decisionModel,
      abortSignal,
      state: 'Nvidia shows its next AI accelerator',
      questions: {
        relevant: {
          type: 'boolean',
          instructions: question(n === 0 ? CHIPS : SECURITY),
        },
      },
    }),
  );
}

describe('CoalescingDecisionModel', () => {
  test('two scorers that score one stream together ask the inner model once for each article, with both questions, and each gets the scores it gets without the decorator', async () => {
    const direct: Call[] = [];
    const alone = model(PROBABILITIES, direct);
    const expected = await Promise.all(
      [CHIPS, SECURITY].map((description) =>
        new DecisionScorer({ model: alone, description }).score(STREAM, {
          signal: running,
        }),
      ),
    );
    const calls: Call[] = [];
    const coalescing = new CoalescingDecisionModel(model(PROBABILITIES, calls));

    const scores = await Promise.all(
      [CHIPS, SECURITY].map((description) =>
        new DecisionScorer({ model: coalescing, description }).score(STREAM, {
          signal: running,
        }),
      ),
    );

    assert.deepEqual(scores.map(read), expected.map(read));
    assert.equal(direct.length, 8);
    assert.deepEqual(
      calls.map(({ texts, questions }) => [
        texts,
        Object.values(questions).map(({ instructions }) => instructions),
      ]),
      [...STREAM.values()].map(({ text }) => [
        [text],
        [question(CHIPS), question(SECURITY)],
      ]),
    );
  });

  test('a lone scorer gets the scores it gets without the decorator, and a lone call reaches the inner model unchanged, with its own signal', async () => {
    const expected = await new DecisionScorer({
      model: model(PROBABILITIES, []),
      description: CHIPS,
    }).score(STREAM, { signal: running });
    const calls: Call[] = [];
    const coalescing = new CoalescingDecisionModel(model(PROBABILITIES, calls));
    const own = new AbortController().signal;
    const questions = {
      relevant: { type: 'boolean' as const, instructions: question(CHIPS) },
    };

    const scores = await new DecisionScorer({
      model: coalescing,
      description: CHIPS,
    }).score(STREAM, { signal: running });
    await experimental_decide({
      model: coalescing,
      abortSignal: own,
      state: 'Nvidia shows its next AI accelerator',
      questions,
    });

    assert.deepEqual(read(scores), read(expected));
    assert.equal(calls.length, 5);
    for (const call of calls.slice(0, 4))
      assert.deepEqual(Object.keys(call.questions), ['relevant']);
    assert.equal(calls[4]?.questions, questions);
    assert.equal(calls[4]?.abortSignal, own);
  });

  test('calls with other options, or with a state that is not text, reach the inner model one by one, unchanged', async () => {
    const calls: Call[] = [];
    const probabilities = new Map([
      [
        question(CHIPS),
        new Map([
          ['Nvidia shows its next AI accelerator', 0.9],
          ['{"type":"json","value":{"title":"Nvidia"}}', 0.8],
        ]),
      ],
    ]);
    const coalescing = new CoalescingDecisionModel(model(probabilities, calls));
    const questions = {
      relevant: { type: 'boolean' as const, instructions: question(CHIPS) },
    };

    await Promise.all([
      ...[5, 6].map((maxOutputTokens) =>
        experimental_decide({
          model: coalescing,
          maxOutputTokens,
          state: 'Nvidia shows its next AI accelerator',
          questions,
        }),
      ),
      ...[1, 2].map(() =>
        experimental_decide({
          model: coalescing,
          state: { title: 'Nvidia' },
          questions,
        }),
      ),
    ]);

    assert.equal(calls.length, 4);
    for (const call of calls) assert.equal(call.questions, questions);
    assert.deepEqual(
      calls.map(({ maxOutputTokens }) => maxOutputTokens).toSorted(),
      [5, 6, undefined, undefined],
    );
  });

  test('a caller that aborts rejects at once with its reason, and the other caller of the merged call gets its answer from an inner call that is not aborted', async () => {
    const calls: Call[] = [];
    const stop = new AbortController();
    const reason = new Error('The page is gone.');
    const settled: string[] = [];
    // Holds the merged call until after the stop.
    const coalescing = new CoalescingDecisionModel(
      model(PROBABILITIES, calls, async () => {
        setTimeout(() => stop.abort(reason), 10);
        await new Promise((resolve) => setTimeout(resolve, 30));
        settled.push('the inner model answers');
      }),
    );

    const [stopped, kept] = await Promise.allSettled(
      ask(coalescing, [stop.signal, running]).map((decision, n) =>
        decision.finally(() => settled.push(`caller ${n} settles`)),
      ),
    );

    assert.deepEqual(stopped, { status: 'rejected', reason });
    assert.deepEqual(settled, [
      'caller 0 settles',
      'the inner model answers',
      'caller 1 settles',
    ]);
    assert.equal(
      kept?.status === 'fulfilled' && kept.value.answers.relevant.probability,
      0.2,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.abortSignal?.aborted, false);
  });

  test('when every caller of a merged call aborts, the inner call aborts', async () => {
    const calls: Call[] = [];
    const stop = new AbortController();
    const reason = new Error('The reader stops.');
    // Holds the merged call until its signal aborts.
    const coalescing = new CoalescingDecisionModel(
      model(PROBABILITIES, calls, (abortSignal) => {
        setTimeout(() => stop.abort(reason), 10);
        return new Promise((_resolve, reject) =>
          abortSignal?.addEventListener(
            'abort',
            () => reject(abortSignal.reason),
            { once: true },
          ),
        );
      }),
    );

    const settled = await Promise.allSettled(
      ask(coalescing, [stop.signal, stop.signal]),
    );

    assert.deepEqual(settled, [
      { status: 'rejected', reason },
      { status: 'rejected', reason },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.abortSignal?.aborted, true);
  });

  test('the usage of a merged call goes to its first caller only, so a sum over the callers is the usage of the inner model', async () => {
    const calls: Call[] = [];
    const coalescing = new CoalescingDecisionModel(model(PROBABILITIES, calls));

    const results = await Promise.all(ask(coalescing, [running, running]));

    assert.equal(calls.length, 1);
    assert.deepEqual(
      results.map(({ usage }) => usage),
      [
        { inputTokens: 40, outputTokens: 2, totalTokens: 42 },
        {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      ],
    );
  });

  test('an inner model that fails rejects every caller of the merged call with its error', async () => {
    const failure = new Error('The decision server is down.');
    const calls: Call[] = [];
    const coalescing = new CoalescingDecisionModel(
      model(PROBABILITIES, calls, async () => {
        throw failure;
      }),
    );

    const settled = await Promise.allSettled(
      ask(coalescing, [running, running]),
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(settled, [
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
  });

  test("a refusal of one scorer's question fails only that score, with the refusal error of the AI SDK", async () => {
    const calls: Call[] = [];
    const probabilities = new Map<
      string,
      ReadonlyMap<string, number | 'refusal'>
    >([
      ...PROBABILITIES,
      [
        question(SECURITY),
        new Map<string, number | 'refusal'>([
          ['Nvidia shows its next AI accelerator', 0.2],
          ['Phishing kits copy bank logins', 'refusal'],
          ['TSMC makes 2 nm chips in Arizona', 0.2],
          ['Cloud company beats its forecast', 0.3],
        ]),
      ],
    ]);
    const coalescing = new CoalescingDecisionModel(model(probabilities, calls));
    const expected = await new DecisionScorer({
      model: model(PROBABILITIES, []),
      description: CHIPS,
    }).score(STREAM, { signal: running });

    const [chips, security] = await Promise.allSettled(
      [CHIPS, SECURITY].map((description) =>
        new DecisionScorer({ model: coalescing, description }).score(STREAM, {
          signal: running,
        }),
      ),
    );

    assert.equal(security?.status, 'rejected');
    assert.ok(
      security?.status === 'rejected' &&
        security.reason instanceof Experimental_DecisionRefusalError,
    );
    assert.deepEqual(
      chips?.status === 'fulfilled' && read(chips.value),
      read(expected),
    );
  });
});
