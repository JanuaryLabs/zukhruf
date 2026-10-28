import { DAY_MS } from './day.ts';
import type { Design } from './design.ts';
import type { Report } from './event-detector.ts';
import type { AnalysedReport } from './event-table.ts';
import { leadOf } from './lead.ts';
import { numbersOf } from './numbers.ts';

// A report as a design reads it: its publish day, its vector text and the
// evidence of its pair score. The detector and the fitter (eval/fit) read
// reports with this one function.
export function analyse(
  report: Report,
  design: Pick<Design, 'lead' | 'vectorText'>,
): AnalysedReport {
  const lead = leadOf(report.title, report.body, design.lead);
  const publishedAt = report.publishedAt.getTime();
  return {
    id: report.id,
    publishedAt,
    day: Math.floor(publishedAt / DAY_MS),
    text:
      lead.title === null || lead.sentences.length === 0
        ? null
        : vectorText(design.vectorText, lead.title, lead.sentences.join(' ')),
    numbers: numbersOf(`${lead.title ?? ''}\n${report.body}`),
    publisher: report.publisher ?? null,
  };
}

// One pass over the template, so a title that holds "{lead}" stays as it is.
function vectorText(template: string, title: string, lead: string): string {
  return template.replaceAll(/\{(title|lead)\}/gu, (_, name) =>
    name === 'title' ? title : lead,
  );
}
