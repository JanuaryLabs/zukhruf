import type { AnalysedReport, EventTable } from '../event-table.ts';
import type { PairScores } from './scores.ts';
import type { Shortlist } from './shortlist.ts';

// Online group average: the report joins the event of its shortlist with the
// highest mean pair score over all members, when that mean is at least the
// threshold. Otherwise it starts a new event. A headline-only report always
// starts a new event (docs/adr/0003).
export function assign(
  report: AnalysedReport,
  table: EventTable,
  shortlist: Shortlist,
  scores: PairScores,
  threshold: number,
): void {
  let best: number | undefined;
  let bestScore = -Infinity;
  if (report.text !== null) {
    scores.remember(report.id, report);
    const candidates = [
      ...new Set(shortlist.of(report.id).map(({ id }) => table.eventOf(id))),
    ].toSorted((a, b) => a - b);
    for (const event of candidates) {
      const members = table.members(event);
      const mean =
        members.reduce((sum, id) => sum + scores.score(report.id, id), 0) /
        members.length;
      if (mean >= threshold && mean > bestScore) {
        best = event;
        bestScore = mean;
      }
    }
  }
  table.insert(report, best ?? table.newEvent());
}
