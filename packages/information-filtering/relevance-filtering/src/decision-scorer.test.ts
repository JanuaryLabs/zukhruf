import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type Experimental_DecisionModel,
  Experimental_DecisionRefusalError,
} from 'ai';

import { DecisionScorer, type Stream, UtilityThreshold } from './index.ts';

// A signal that no test aborts.
const running = new AbortController().signal;

// No decision model can run in a test, and ai/test has no mock decision
// model. This stand-in is a decision model of the provider interface, under
// the real experimental_decide. It answers one boolean question with the
// instructions that the test names, about a text that the test names, so a
// scorer that asks another question, or about another text, fails.
function model(
  instructions: string,
  answers: ReadonlyMap<string, number | 'refusal' | Error>,
): Experimental_DecisionModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'decision-stand-in',
    supportedQuestionTypes: ['boolean'],
    doDecide: async ({ state, questions }) => {
      const entries = Object.entries(questions);
      const [entry] = entries;
      if (entries.length !== 1 || entry === undefined)
        throw new Error(`The scorer asked ${entries.length} questions.`);
      const [id, question] = entry;
      if (question.type !== 'boolean' || question.instructions !== instructions)
        throw new Error(`The scorer asked ${JSON.stringify(question)}.`);
      const [part] = state;
      if (state.length !== 1 || part?.type !== 'text')
        throw new Error(`The scorer gave the state ${JSON.stringify(state)}.`);
      const answer = answers.get(part.text);
      if (answer === undefined)
        throw new Error(`The test has no answer about ${part.text}.`);
      if (answer instanceof Error) throw answer;
      return {
        answers: {
          [id]:
            answer === 'refusal'
              ? { type: 'refusal' }
              : { type: 'boolean', probability: answer },
        },
        warnings: [],
      };
    },
  };
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 9, n));
}

// The stream in the order of the list: id, text and publish day.
function stream(
  ...articles: readonly (readonly [string, string, number])[]
): Stream {
  return new Map(
    articles.map(([id, text, published]) => [
      id,
      { publishedAt: day(published), text },
    ]),
  );
}

// The chips profile of research round 13, whose question to d1-2B was
// 'Is the main subject of this article: <description>?' word for word.
const DESCRIPTION =
  'New computer chips and AI hardware, and how chips are made and supplied.';
const QUESTION =
  'Is the main subject of this article: New computer chips and AI hardware, and how chips are made and supplied.?';

describe('DecisionScorer', () => {
  test('asks the model if the main subject of the text of each article is the description, and ranks by its probability alone, equal probabilities by id, and a range keeps that order', async () => {
    const scorer = new DecisionScorer({
      model: model(
        QUESTION,
        new Map([
          ['Nvidia ships a new GPU', 0.95],
          ['A chip plant opens in Arizona', 0.7],
          ['TSMC raises chip output', 0.7],
          ['A chip of paint falls off a bridge', 0.1],
        ]),
      ),
      description: DESCRIPTION,
    });

    const scores = await scorer.score(
      stream(
        ['paint', 'A chip of paint falls off a bridge', 10],
        ['tsmc', 'TSMC raises chip output', 11],
        ['gpu', 'Nvidia ships a new GPU', 12],
        ['arizona', 'A chip plant opens in Arizona', 13],
      ),
      { signal: running },
    );

    assert.deepEqual(scores.ranked(), ['gpu', 'arizona', 'tsmc', 'paint']);
    assert.deepEqual(
      ['gpu', 'arizona', 'tsmc', 'paint'].map((id) => scores.probability(id)),
      [0.95, 0.7, 0.7, 0.1],
    );
    assert.deepEqual(scores.ranked({ from: day(10), to: day(11) }), [
      'tsmc',
      'paint',
    ]);
  });

  test('a threshold decides yes or no on the probabilities of the model, with no fixed cut at 0.5', async () => {
    const scores = await new DecisionScorer({
      model: model(
        QUESTION,
        new Map([
          ['Nvidia ships a new GPU', 0.95],
          ['Intel delays a chip', 0.3],
          ['A bank raises rates', 0.2],
        ]),
      ),
      description: DESCRIPTION,
    }).score(
      stream(
        ['gpu', 'Nvidia ships a new GPU', 10],
        ['intel', 'Intel delays a chip', 11],
        ['bank', 'A bank raises rates', 12],
      ),
      { signal: running },
    );

    assert.deepEqual(
      scores.accepted(new UtilityThreshold({ falseAlarm: 1, miss: 3 })),
      ['gpu', 'intel'],
    );
  });

  test('an empty stream gives empty scores and asks the model nothing', async () => {
    const scores = await new DecisionScorer({
      model: model(QUESTION, new Map()),
      description: DESCRIPTION,
    }).score(new Map(), { signal: running });

    assert.deepEqual(scores.ranked(), []);
  });

  test('a question that the model refuses fails the score with the refusal error of the AI SDK, and does not rank the article', async () => {
    const scorer = new DecisionScorer({
      model: model(
        QUESTION,
        new Map<string, number | 'refusal'>([
          ['Nvidia ships a new GPU', 0.95],
          ['A leaked chip roadmap', 'refusal'],
        ]),
      ),
      description: DESCRIPTION,
    });

    await assert.rejects(
      scorer.score(
        stream(
          ['gpu', 'Nvidia ships a new GPU', 10],
          ['leak', 'A leaked chip roadmap', 11],
        ),
        { signal: running },
      ),
      Experimental_DecisionRefusalError,
    );
  });

  test('a model that fails fails the score with its error, and does not rank the article', async () => {
    const failure = new Error('The decision server is down.');
    const scorer = new DecisionScorer({
      model: model(
        QUESTION,
        new Map<string, number | Error>([
          ['Nvidia ships a new GPU', 0.95],
          ['A chip plant opens in Arizona', failure],
        ]),
      ),
      description: DESCRIPTION,
    });

    await assert.rejects(
      scorer.score(
        stream(
          ['gpu', 'Nvidia ships a new GPU', 10],
          ['arizona', 'A chip plant opens in Arizona', 11],
        ),
        { signal: running },
      ),
      (error) => error === failure,
    );
  });

  test('keeps at most 8 calls to the model in flight on a stream of 20 articles', async () => {
    let inFlight = 0;
    let most = 0;
    // Answers each call after a timer, so the calls that the scorer starts
    // meanwhile run together.
    const counting: Experimental_DecisionModel = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'decision-stand-in',
      supportedQuestionTypes: ['boolean'],
      doDecide: async ({ questions }) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'boolean', probability: 0.5 },
            ]),
          ),
          warnings: [],
        };
      },
    };
    const articles = Array.from(
      { length: 20 },
      (_, n) => [`a${n}`, `Article ${n}`, 10] as const,
    );

    const scores = await new DecisionScorer({
      model: counting,
      description: DESCRIPTION,
    }).score(stream(...articles), { signal: running });

    assert.equal(most, 8);
    assert.equal(scores.ranked().length, 20);
  });

  test('ranks the same when the answers arrive in another order than the questions', async () => {
    const probabilities = new Map([
      ['A chip of paint falls off a bridge', 0.1],
      ['TSMC raises chip output', 0.7],
      ['Nvidia ships a new GPU', 0.95],
      ['A chip plant opens in Arizona', 0.7],
    ]);
    // The first article of the stream is answered last, and the last first.
    const delays = new Map([
      ['A chip of paint falls off a bridge', 40],
      ['TSMC raises chip output', 30],
      ['Nvidia ships a new GPU', 20],
      ['A chip plant opens in Arizona', 10],
    ]);
    const answered: string[] = [];
    const late: Experimental_DecisionModel = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'decision-stand-in',
      supportedQuestionTypes: ['boolean'],
      doDecide: async ({ state, questions }) => {
        const [part] = state;
        const text = part?.type === 'text' ? part.text : '';
        await new Promise((resolve) => setTimeout(resolve, delays.get(text)));
        answered.push(text);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'boolean', probability: probabilities.get(text) ?? NaN },
            ]),
          ),
          warnings: [],
        };
      },
    };

    const scores = await new DecisionScorer({
      model: late,
      description: DESCRIPTION,
    }).score(
      stream(
        ['paint', 'A chip of paint falls off a bridge', 10],
        ['tsmc', 'TSMC raises chip output', 11],
        ['gpu', 'Nvidia ships a new GPU', 12],
        ['arizona', 'A chip plant opens in Arizona', 13],
      ),
      { signal: running },
    );

    assert.deepEqual(answered, [
      'A chip plant opens in Arizona',
      'Nvidia ships a new GPU',
      'TSMC raises chip output',
      'A chip of paint falls off a bridge',
    ]);
    assert.deepEqual(scores.ranked(), ['gpu', 'arizona', 'tsmc', 'paint']);
  });

  test('a model that fails stops the other calls: they abort, and the model is asked about no later article', async () => {
    const failure = new Error('The decision server is down.');
    const asked: string[] = [];
    const aborted: string[] = [];
    // Fails the first article from a timer, and holds every other call until
    // its signal aborts, as fetch rejects a pending request.
    const failing: Experimental_DecisionModel = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'decision-stand-in',
      supportedQuestionTypes: ['boolean'],
      doDecide: async ({ state, abortSignal }) => {
        if (abortSignal === undefined)
          throw new Error('The scorer gave the model no signal.');
        const [part] = state;
        const text = part?.type === 'text' ? part.text : '';
        asked.push(text);
        if (text === 'Article 0')
          return new Promise((_, reject) =>
            setTimeout(() => reject(failure), 10),
          );
        return new Promise((_, reject) =>
          abortSignal.addEventListener(
            'abort',
            () => {
              aborted.push(text);
              reject(abortSignal.reason);
            },
            { once: true },
          ),
        );
      },
    };
    const articles = Array.from(
      { length: 20 },
      (_, n) => [`a${n}`, `Article ${n}`, 10] as const,
    );

    await assert.rejects(
      new DecisionScorer({ model: failing, description: DESCRIPTION }).score(
        stream(...articles),
        { signal: running },
      ),
      (error) => error === failure,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      asked,
      Array.from({ length: 8 }, (_, n) => `Article ${n}`),
    );
    assert.deepEqual(aborted, asked.slice(1));
  });

  test('a stop while the model answers ends the score with the reason of the signal, aborts the calls that run, and no question starts after the stop', async () => {
    const stop = new AbortController();
    const reason = new Error('The reader stops.');
    const asked: string[] = [];
    const aborted: string[] = [];
    // Holds each call until its signal aborts, and rejects it then, as fetch
    // rejects a pending request. The stop comes from a timer while the first
    // 8 calls run.
    const stopping: Experimental_DecisionModel = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'decision-stand-in',
      supportedQuestionTypes: ['boolean'],
      doDecide: async ({ state, abortSignal }) => {
        if (abortSignal === undefined)
          throw new Error('The scorer gave the model no signal.');
        const [part] = state;
        const text = part?.type === 'text' ? part.text : '';
        asked.push(text);
        return new Promise((_, reject) =>
          abortSignal.addEventListener(
            'abort',
            () => {
              aborted.push(text);
              reject(abortSignal.reason);
            },
            { once: true },
          ),
        );
      },
    };
    const articles = Array.from(
      { length: 20 },
      (_, n) => [`a${n}`, `Article ${n}`, 10] as const,
    );
    setTimeout(() => stop.abort(reason), 10);

    await assert.rejects(
      new DecisionScorer({ model: stopping, description: DESCRIPTION }).score(
        stream(...articles),
        { signal: stop.signal },
      ),
      (error) => error === reason,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      asked,
      Array.from({ length: 8 }, (_, n) => `Article ${n}`),
    );
    assert.deepEqual(aborted, asked);
  });
});
