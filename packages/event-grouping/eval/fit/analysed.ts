import { DatabaseSync } from 'node:sqlite';

import { analyse } from '../../src/analyse.ts';
import type { AnalysedReport } from '../../src/event-table.ts';
import type { Design, Report } from '../../src/index.ts';
import { eventSchema } from '../../src/schema.ts';
import { Templates } from '../../src/templates.ts';

// The reports as the detector reads them when feed (eval/feed.ts) gives them
// to it: one add for each publish day, in the order of the publish dates. The
// template segments of a publisher (src/templates.ts) come from the reports
// of the days before and of the same day, as in the detector.
export function analysedAsFed(
  reports: readonly Report[],
  design: Pick<Design, 'lead' | 'vectorText'>,
): Map<string, AnalysedReport> {
  using database = new DatabaseSync(':memory:');
  eventSchema.apply(database);
  const templates = new Templates(database, design.lead);
  const analysed = new Map<string, AnalysedReport>();
  const sorted = reports.toSorted(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime(),
  );
  for (const batch of Map.groupBy(sorted, (report) =>
    report.publishedAt.toISOString().slice(0, 10),
  ).values()) {
    templates.observe(batch);
    for (const report of batch)
      analysed.set(
        report.id,
        analyse(report, design, templates.of(report.publisher)),
      );
  }
  return analysed;
}
