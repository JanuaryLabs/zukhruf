import { Declaration } from '@zukhruf/sqlite-drift';

// The event of each report, the clock of the detector, and the segments of
// the reports of each publisher (src/templates.ts). The rows derive
// from the reports, so a stale table is replaced with its rows: the caller
// adds the reports again.
export const eventSchema = new Declaration(
  [
    `CREATE TABLE event_report (
  id TEXT PRIMARY KEY,
  event INTEGER NOT NULL,
  -- Milliseconds since the Unix epoch.
  published_at INTEGER NOT NULL,
  -- The UTC publish day: whole days since the Unix epoch.
  day INTEGER NOT NULL,
  -- 1 when the report has a lead, 0 for a headline-only report.
  has_lead INTEGER NOT NULL,
  -- The numbers of the title and the body, with a space between them. A
  -- number has no space in it.
  numbers TEXT NOT NULL,
  -- Null when the caller gave no publisher.
  publisher TEXT
) STRICT`,
    `CREATE INDEX event_report_event ON event_report (event)`,
    `CREATE INDEX event_report_day ON event_report (day)`,
    `CREATE TABLE event_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- The latest publish day that the detector got.
  current_day INTEGER NOT NULL,
  -- The id of the next new event. An event id is never used again.
  next_event INTEGER NOT NULL
) STRICT`,
    `CREATE TABLE event_segment (
  publisher TEXT NOT NULL,
  -- A hash of the segment in lower case, with one space between words.
  segment TEXT NOT NULL,
  report TEXT NOT NULL,
  PRIMARY KEY (publisher, segment, report)
) STRICT, WITHOUT ROWID`,
  ],
  { rows: 'replace' },
);
