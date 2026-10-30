import type { DatabaseSync } from 'node:sqlite';

import type { Evidence } from './pair-score.ts';

// A report after the detector read it.
export type AnalysedReport = Evidence & {
  readonly id: string;
  readonly publishedAt: number;
  readonly day: number;
  // The text of the vector. Null for a headline-only report.
  readonly text: string | null;
};

// The rows of the detector in the caller's database.
export class EventTable {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  has(id: string): boolean {
    return (
      this.#database
        .prepare('SELECT 1 FROM "event_report" WHERE "id" = ?')
        .get(id) !== undefined
    );
  }

  eventOf(id: string): number {
    const row = this.#database
      .prepare('SELECT "event" FROM "event_report" WHERE "id" = ?')
      .get(id);
    if (row === undefined) throw new Error(`No report has the id ${id}.`);
    return Number(row.event);
  }

  members(event: number): string[] {
    return this.#database
      .prepare(
        'SELECT "id" FROM "event_report" WHERE "event" = ? ORDER BY "published_at", "id"',
      )
      .all(event)
      .map((row) => String(row.id));
  }

  evidenceOf(id: string): Evidence {
    const row = this.#database
      .prepare(
        'SELECT "numbers", "publisher" FROM "event_report" WHERE "id" = ?',
      )
      .get(id);
    if (row === undefined) throw new Error(`No report has the id ${id}.`);
    const numbers = String(row.numbers);
    return {
      numbers: new Set(numbers === '' ? [] : numbers.split(' ')),
      publisher: row.publisher === null ? null : String(row.publisher),
    };
  }

  // The reports with a lead, published on the day or later, in the order of
  // their ids.
  withLeadSince(day: number): string[] {
    return this.#database
      .prepare(
        'SELECT "id" FROM "event_report" WHERE "day" >= ? AND "has_lead" = 1 ORDER BY "id"',
      )
      .all(day)
      .map((row) => String(row.id));
  }

  insert(report: AnalysedReport, event: number): void {
    this.#database
      .prepare(
        'INSERT INTO "event_report" ("id", "event", "published_at", "day", "has_lead", "numbers", "publisher") VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        report.id,
        event,
        report.publishedAt,
        report.day,
        report.text === null ? 0 : 1,
        [...report.numbers].join(' '),
        report.publisher,
      );
  }

  move(id: string, event: number): void {
    this.#database
      .prepare('UPDATE "event_report" SET "event" = ? WHERE "id" = ?')
      .run(event, id);
  }

  currentDay(): number | undefined {
    const row = this.#database
      .prepare('SELECT "current_day" FROM "event_clock" WHERE "id" = 1')
      .get();
    return row === undefined ? undefined : Number(row.current_day);
  }

  advance(day: number): void {
    this.#database
      .prepare(
        `INSERT INTO "event_clock" ("id", "current_day", "next_event") VALUES (1, ?, 0)
        ON CONFLICT ("id") DO UPDATE SET "current_day" = max("current_day", excluded."current_day")`,
      )
      .run(day);
  }

  newEvent(): number {
    const row = this.#database
      .prepare(
        'UPDATE "event_clock" SET "next_event" = "next_event" + 1 WHERE "id" = 1 RETURNING "next_event" - 1 AS "event"',
      )
      .get();
    if (row === undefined) throw new Error('The clock has no row.');
    return Number(row.event);
  }

  rows(since: number): { id: string; event: number; publishedAt: number }[] {
    return this.#database
      .prepare(
        `SELECT "id", "event", "published_at" FROM "event_report"
        WHERE "event" IN (SELECT "event" FROM "event_report" GROUP BY "event" HAVING max("published_at") >= ?)
        ORDER BY "published_at", "id"`,
      )
      .all(since)
      .map((row) => ({
        id: String(row.id),
        event: Number(row.event),
        publishedAt: Number(row.published_at),
      }));
  }
}
