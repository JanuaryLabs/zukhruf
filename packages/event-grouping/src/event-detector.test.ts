import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection } from '@zukhruf/embeddings';

import {
  type Event,
  EventDetector,
  type Report,
  type Vectors,
} from './index.ts';

// A real embedding model cannot run in CI. The AI SDK's own mock model stands
// in for it. It gives the vector that the test names for the title in each
// text, and fails on a title the test did not name.
function model(
  vectors: Record<string, readonly number[]>,
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: Infinity,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((text) => {
        const title = /^title: (.*?) \| text: /su.exec(text)?.[1] ?? '';
        const vector = vectors[title];
        if (vector === undefined)
          throw new Error(`The test names no vector for ${text}`);
        return [...vector];
      }),
      warnings: [],
    }),
  });
}

function detector(
  database: DatabaseSync,
  fake: MockEmbeddingModelV4,
): EventDetector {
  const vectors = new Collection({ database, model: fake }) satisfies Vectors;
  return new EventDetector({ database, vectors });
}

// A unit vector at an angle, in degrees. Without numbers, two reports join
// when their angle is at most 36 degrees (cosine 0.809, pair score 0.55),
// and not at 37 degrees (cosine 0.799, pair score 0.47).
function at(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

function day(n: number, hours = 0, minutes = 0): Date {
  return new Date(Date.UTC(2026, 9, n, hours, minutes));
}

// Two real sentences with no numbers.
const BODY =
  'Officials said the event happened in the city this morning. Witnesses described the scene to local reporters.';

function report(
  id: string,
  title: string,
  publishedAt: Date,
  body = BODY,
): Report {
  return { id, title, body, publishedAt };
}

// The members of each event, as sorted lists, in a sorted list.
function partition(events: readonly Event[]): string[][] {
  return events
    .map((event) => event.members.toSorted())
    .toSorted((a, b) => (a.join() < b.join() ? -1 : 1));
}

function everything(detector: EventDetector): Event[] {
  return detector.events({ since: new Date(0) });
}

describe('EventDetector', () => {
  test('a headline-only report never joins another report, and no report joins it', async () => {
    using database = new DatabaseSync(':memory:');
    const fake = model({
      'Storm closes port': at(0),
      'Storm shuts harbour': at(5),
    });
    const events = detector(database, fake);

    await events.add([
      report(
        'headline',
        'Storm closes port',
        day(1),
        'https://news.example/storm-closes-port\nPhoto: Reuters',
      ),
      report('first', 'Storm closes port', day(1)),
      report('second', 'Storm shuts harbour', day(1)),
    ]);
    await events.add([report('next-day', 'Storm shuts harbour', day(2))]);

    assert.deepEqual(partition(everything(events)), [
      ['first', 'next-day', 'second'],
      ['headline'],
    ]);
  });

  test('the vector text is the title and the first two real sentences, without URL lines, URLs and bylines', async () => {
    using database = new DatabaseSync(':memory:');
    const fake = model({ 'Storm closes port': at(0) });

    await detector(database, fake).add([
      report(
        'storm',
        'Storm closes port',
        day(1),
        [
          'Read the whole story at https://news.example/2026/10/01/storm-closes-the-port-on-monday-morning-and-ships-wait',
          'By Jane Doe',
          'The storm closed the port early on Monday morning.',
          'Officials said the notice for all ships is at https://port.example/notice.',
          'Ships waited outside the harbour for many hours.',
        ].join('\n'),
      ),
    ]);

    assert.deepEqual(
      fake.doEmbedCalls.flatMap(({ values }) => values),
      [
        'title: Storm closes port | text: Storm closes port\nThe storm closed the port early on Monday morning. Officials said the notice for all ships is at',
      ],
    );
  });

  test('numbers that agree join a pair that is too far apart alone, and numbers that disagree split a pair that is near enough alone', async () => {
    const angle = (cosine: number) => Math.acos(cosine) * (180 / Math.PI);
    const group = async (cosine: number, first: string, second: string) => {
      using database = new DatabaseSync(':memory:');
      const events = detector(
        database,
        model({ North: at(0), South: at(angle(cosine)) }),
      );
      await events.add([
        report('first', 'North', day(1), `${BODY} ${first}`),
        report('second', 'South', day(1), `${BODY} ${second}`),
      ]);
      return partition(everything(events));
    };

    // At a cosine of 0.78, the pair score with no numbers is 0.34.
    const far = await group(0.78, '', '');
    // "143,000" is "143000", and "v14" is "14".
    const farAgree = await group(
      0.78,
      'They counted 143,000 votes in v14 of the count.',
      'They counted 143000 votes in 14 of the count.',
    );
    // At a cosine of 0.85, the pair score with no numbers is 0.81.
    const near = await group(0.85, '', '');
    const nearDisagree = await group(
      0.85,
      'They found 12 shells, 3 cars, 7 guns and 2016 rifles.',
      'They found 40 shells, 5 cars, 9 guns and 2019 rifles.',
    );

    assert.deepEqual(far, [['first'], ['second']]);
    assert.deepEqual(farAgree, [['first', 'second']]);
    assert.deepEqual(near, [['first', 'second']]);
    assert.deepEqual(nearDisagree, [['first'], ['second']]);
  });

  test('a report joins a report of up to 7 publish days before it, and not of 8 days before it', async () => {
    const group = async (later: Date) => {
      using database = new DatabaseSync(':memory:');
      const events = detector(
        database,
        model({ 'Storm closes port': at(0), 'Storm shuts harbour': at(0) }),
      );
      await events.add([report('first', 'Storm closes port', day(1))]);
      await events.add([report('later', 'Storm shuts harbour', later)]);
      return partition(everything(events));
    };

    const seventhDay = await group(day(8, 23, 59));
    const eighthDay = await group(day(9));

    assert.deepEqual(seventhDay, [['first', 'later']]);
    assert.deepEqual(eighthDay, [['first'], ['later']]);
  });

  test('the first report of a new publish day makes the detector cluster the window again', async () => {
    using database = new DatabaseSync(':memory:');
    const events = detector(
      database,
      model({ A: at(0), B: at(35), C: at(60), D: at(180) }),
    );

    // Online, B joins A (0.63), and C cannot join A and B (mean 0.48).
    await events.add([
      report('a', 'A', day(1)),
      report('b', 'B', day(1)),
      report('c', 'C', day(1)),
    ]);
    // A later report of the same day does not start a clustering.
    await events.add([report('e', 'D', day(1, 12))]);
    const online = partition(everything(events));
    await events.add([report('d', 'D', day(2))]);

    assert.deepEqual(online, [['a', 'b'], ['c'], ['e']]);
    // Group average joins B and C first (0.96), and A cannot join them (0.31).
    assert.deepEqual(partition(everything(events)), [
      ['a'],
      ['b', 'c'],
      ['d', 'e'],
    ]);
  });

  test('the clustering takes the reports of the 7 publish days before the new day', async () => {
    using database = new DatabaseSync(':memory:');
    const events = detector(
      database,
      model({ A: at(0), B: at(35), C: at(60), D: at(180) }),
    );
    await events.add([report('a', 'A', day(1))]);
    // Online, B joins A of day 1, and C cannot join them.
    await events.add([report('b', 'B', day(2)), report('c', 'C', day(2))]);

    await events.add([report('d', 'D', day(3))]);

    assert.deepEqual(partition(everything(events)), [['a'], ['b', 'c'], ['d']]);
  });

  test('every arrival order of the reports of one day gives the same events once the day closes', async () => {
    const ids = ['a', 'b', 'c'];
    const orders = ids.flatMap((first) =>
      ids
        .filter((id) => id !== first)
        .flatMap((second) => [
          [first, second, ...ids.filter((id) => id !== first && id !== second)],
        ]),
    );
    const results: string[][][] = [];

    for (const order of orders) {
      using database = new DatabaseSync(':memory:');
      const events = detector(
        database,
        model({ A: at(0), B: at(35), C: at(60), D: at(180) }),
      );
      await events.add(order.map((id) => report(id, id.toUpperCase(), day(1))));
      await events.add([report('d', 'D', day(2))]);
      results.push(partition(everything(events)));
    }

    assert.equal(orders.length, 6);
    for (const result of results)
      assert.deepEqual(result, [['a'], ['b', 'c'], ['d']]);
  });

  test('an event keeps its id through the clustering of a new day, by its largest overlap', async () => {
    using database = new DatabaseSync(':memory:');
    const events = detector(
      database,
      model({ Port: at(0), Harbour: at(90), Other: at(225) }),
    );
    // The ids of the second event sort first, so the clustering meets it
    // first.
    await events.add([
      report('z-port-1', 'Port', day(1)),
      report('z-port-2', 'Port', day(1)),
      report('a-harbour-1', 'Harbour', day(1)),
      report('a-harbour-2', 'Harbour', day(1)),
    ]);
    const before = new Map(
      everything(events).map((event) => [
        event.members.toSorted().join(),
        event.id,
      ]),
    );

    await events.add([
      report('z-port-3', 'Port', day(2)),
      report('other', 'Other', day(2)),
    ]);
    const after = new Map(
      everything(events).map((event) => [
        event.members.toSorted().join(),
        event.id,
      ]),
    );

    assert.equal(
      after.get('z-port-1,z-port-2,z-port-3'),
      before.get('z-port-1,z-port-2'),
    );
    assert.equal(
      after.get('a-harbour-1,a-harbour-2'),
      before.get('a-harbour-1,a-harbour-2'),
    );
    assert.notEqual(
      before.get('z-port-1,z-port-2'),
      before.get('a-harbour-1,a-harbour-2'),
    );
  });

  test('a cluster that takes reports of two old events keeps the id of the old event with more of its reports', async () => {
    using database = new DatabaseSync(':memory:');
    const events = detector(
      database,
      model({ Q: at(0), Pa: at(38), Pb: at(21), Far: at(200) }),
    );
    // Online, P1 cannot join Q (0.40), and P2 joins P1 (0.97) over Q (0.95).
    // So the old event of Q has the lower id.
    await events.add([
      report('q', 'Q', day(1)),
      report('p1', 'Pa', day(1)),
      report('p2', 'Pb', day(1)),
    ]);
    const before = everything(events);

    // Group average joins P1 and P2, and then Q (mean 0.67).
    await events.add([report('far', 'Far', day(2))]);
    const after = everything(events);

    const idOf = (list: readonly Event[], id: string) =>
      list.find((event) => event.members.includes(id))?.id;
    assert.deepEqual(partition(before), [['p1', 'p2'], ['q']]);
    assert.ok((idOf(before, 'q') ?? 0) < (idOf(before, 'p1') ?? 0));
    assert.deepEqual(partition(after), [['far'], ['p1', 'p2', 'q']]);
    assert.equal(idOf(after, 'q'), idOf(before, 'p1'));
  });

  test('one add gives its reports their events in the order of their publish dates, with the same ids every time', async () => {
    const run = async () => {
      using database = new DatabaseSync(':memory:');
      const events = detector(
        database,
        model({ A: at(0), B: at(35), C: at(60), D: at(180) }),
      );
      await events.add([
        report('d', 'D', day(2)),
        report('c', 'C', day(1, 9)),
        report('a', 'A', day(1, 8)),
        report('b', 'B', day(1, 10)),
      ]);
      return everything(events);
    };

    const first = await run();
    const second = await run();

    assert.deepEqual(first, second);
    // A starts event 0 and C event 1. B joins C. D closes day 1, and the
    // clustering keeps both ids. D starts event 2.
    assert.deepEqual(first, [
      { id: 0, members: ['a'], firstSeen: day(1, 8), lastSeen: day(1, 8) },
      {
        id: 1,
        members: ['c', 'b'],
        firstSeen: day(1, 9),
        lastSeen: day(1, 10),
      },
      { id: 2, members: ['d'], firstSeen: day(2), lastSeen: day(2) },
    ]);
  });

  test('an add that fails gives none of its reports an event, and the same reports can be added again', async () => {
    using database = new DatabaseSync(':memory:');
    const events = detector(database, model({ A: at(0), B: at(5) }));

    // Two reports with one id fail on the second one.
    await assert.rejects(
      events.add([
        report('a', 'A', day(1)),
        report('b', 'B', day(1)),
        report('b', 'B', day(1)),
      ]),
    );
    const afterFailure = everything(events);
    await events.add([report('a', 'A', day(1)), report('b', 'B', day(1))]);

    assert.deepEqual(afterFailure, []);
    assert.deepEqual(partition(everything(events)), [['a', 'b']]);
  });

  test('vectors that a failed add left behind take no place in the shortlist of 80 reports', async () => {
    // Dimension 0 is the report, 1 to 79 are 79 decoys, 80 is the target, and
    // 81 and 82 are the two vectors that a failed add leaves behind.
    const axis = (index: number, cosine: number) =>
      Array.from({ length: 83 }, (_, at) =>
        at === 0 ? cosine : at === index ? Math.sqrt(1 - cosine * cosine) : 0,
      );
    const name = (index: number) =>
      `Decoy ${String.fromCodePoint(97 + Math.floor(index / 26), 97 + (index % 26))}`;
    const decoys = Array.from({ length: 79 }, (_, index) => index + 1);
    using database = new DatabaseSync(':memory:');
    const events = detector(
      database,
      model({
        Report: axis(0, 1),
        Target: axis(80, 0.68),
        'Left one': axis(81, 0.95),
        'Left two': axis(82, 0.95),
        ...Object.fromEntries(
          decoys.map((index) => [name(index), axis(index, 0.7)]),
        ),
      }),
    );
    await assert.rejects(
      events.add([
        report('left-1', 'Left one', day(1)),
        report('left-2', 'Left two', day(1)),
        report('left-2', 'Left two', day(1)),
      ]),
    );
    // Ten shared numbers join the report and the target at a cosine of 0.68.
    // The decoys are nearer, but no decoy can join (0.04).
    const numbers = 'The count was 11, 12, 13, 14, 15, 16, 17, 18, 19 and 20.';
    await events.add([
      ...decoys.map((index) => report(`decoy-${index}`, name(index), day(1))),
      report('target', 'Target', day(1), `${BODY} ${numbers}`),
    ]);

    await events.add([
      report('report', 'Report', day(1), `${BODY} ${numbers}`),
    ]);

    assert.deepEqual(
      everything(events).find((event) => event.members.includes('report'))
        ?.members,
      ['report', 'target'],
    );
  });

  test('events gives only the events with a report published at or after since', async () => {
    using database = new DatabaseSync(':memory:');
    const events = detector(
      database,
      model({ Old: at(0), Running: at(90), New: at(91) }),
    );
    await events.add([
      report('old', 'Old', day(1)),
      report('running-1', 'Running', day(1)),
      report('running-2', 'New', day(5)),
    ]);

    assert.deepEqual(partition(events.events({ since: day(5) })), [
      ['running-1', 'running-2'],
    ]);
  });

  test('a report that the detector has already is skipped and keeps its event', async () => {
    using database = new DatabaseSync(':memory:');
    const fake = model({ 'Storm closes port': at(0), 'Fire downtown': at(90) });
    const events = detector(database, fake);
    await events.add([report('storm', 'Storm closes port', day(1))]);
    const [before] = everything(events);

    await events.add([report('storm', 'Fire downtown', day(1))]);

    assert.deepEqual(everything(events), [before]);
    assert.equal(fake.doEmbedCalls.flatMap(({ values }) => values).length, 1);
  });
});
