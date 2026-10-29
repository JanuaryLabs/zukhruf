import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { Design } from './design.ts';
import type { Report } from './event-detector.ts';
import { type IsTemplate, segmentsOf } from './lead.ts';

const none: IsTemplate = () => false;

// The segments that a publisher repeats in its reports: banners, promotions,
// player widgets and other text of the site template. A segment is a
// template when at least templateReports reports of one publisher hold it.
// This is site-level template detection (Bar-Yossef and Rajagopalan, WWW
// 2002): text that many pages of one site share is not the content of a
// page. The detector keeps the key of each segment of each report with a
// publisher in event_segment.
export class Templates {
  readonly #database: DatabaseSync;
  readonly #rule: Design['lead'];

  constructor(database: DatabaseSync, rule: Design['lead']) {
    this.#database = database;
    this.#rule = rule;
  }

  // Keeps the segments of each report with a publisher. Call it for all the
  // reports of an add before their leads, so the reports of one add count
  // for each other.
  observe(reports: readonly Report[]): void {
    if (this.#rule.clean?.templateReports == null) return;
    const insert = this.#database.prepare(
      'INSERT OR IGNORE INTO "event_segment" ("publisher", "segment", "report") VALUES (?, ?, ?)',
    );
    for (const report of reports)
      if (report.publisher !== undefined)
        for (const key of new Set(
          segmentsOf(report.body, this.#rule).map(({ key }) => key),
        ))
          insert.run(report.publisher, hash(key), report.id);
  }

  // The test of the template segments of one publisher. A report without a
  // publisher has no template segment.
  of(publisher: string | undefined): IsTemplate {
    const reports = this.#rule.clean?.templateReports;
    if (reports == null || publisher === undefined) return none;
    const templates = new Set(
      this.#database
        .prepare(
          'SELECT "segment" FROM "event_segment" WHERE "publisher" = ? GROUP BY "segment" HAVING count(*) >= ?',
        )
        .all(publisher, reports)
        .map((row) => String(row.segment)),
    );
    return templates.size === 0 ? none : (key) => templates.has(hash(key));
  }
}

function hash(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 22);
}
