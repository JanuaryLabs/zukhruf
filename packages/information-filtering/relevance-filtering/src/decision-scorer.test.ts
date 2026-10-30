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

  test('a stop while the model answers ends the score with the reason of the signal, and the model is asked about no later article', async () => {
    const stop = new AbortController();
    const reason = new Error('The reader stops.');
    const asked: string[] = [];
    // Answers the first article, and raises the stop from a timer while the
    // second is asked. It rejects the second when its signal aborts, as fetch
    // rejects a pending request.
    const stopping: Experimental_DecisionModel = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'decision-stand-in',
      supportedQuestionTypes: ['boolean'],
      doDecide: async ({ state, questions, abortSignal }) => {
        if (abortSignal === undefined)
          throw new Error('The scorer gave the model no signal.');
        const [part] = state;
        asked.push(part?.type === 'text' ? part.text : '');
        if (asked.length > 1)
          return new Promise((_, reject) =>
            abortSignal.addEventListener(
              'abort',
              () => reject(abortSignal.reason),
              { once: true },
            ),
          );
        setTimeout(() => stop.abort(reason), 10);
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'boolean', probability: 0.9 },
            ]),
          ),
          warnings: [],
        };
      },
    };

    await assert.rejects(
      new DecisionScorer({ model: stopping, description: DESCRIPTION }).score(
        stream(
          ['gpu', 'Nvidia ships a new GPU', 10],
          ['tsmc', 'TSMC raises chip output', 11],
          ['paint', 'A chip of paint falls off a bridge', 12],
        ),
        { signal: stop.signal },
      ),
      (error) => error === reason,
    );
    assert.deepEqual(asked, [
      'Nvidia ships a new GPU',
      'TSMC raises chip output',
    ]);
  });
});
