import { DAY_MS } from './day.ts';
import type { Design } from './design.ts';
import type { Report } from './event-detector.ts';
import type { AnalysedReport } from './event-table.ts';
import { type IsTemplate, leadOf, numberText } from './lead.ts';
import { numbersOf } from './numbers.ts';

// A report as a design reads it: its publish day, its vector text and the
// evidence of its pair score. The detector and the fitter (eval/fit) read
// reports with this one function. isTemplate: the template segments of the
// publisher of the report (src/templates.ts).
export function analyse(
  report: Report,
  design: Pick<Design, 'lead' | 'vectorText'>,
  isTemplate?: IsTemplate,
): AnalysedReport {
  const lead = leadOf(report.title, report.body, design.lead, isTemplate);
  const publishedAt = report.publishedAt.getTime();
  return {
    id: report.id,
    publishedAt,
    day: Math.floor(publishedAt / DAY_MS),
    text:
      lead.title === null || lead.sentences.length === 0
        ? null
        : vectorText(design.vectorText, lead.title, lead.sentences.join(' ')),
    numbers: numbersOf(
      numberText(lead.title ?? '', report.body, design.lead, isTemplate),
    ),
    publisher: report.publisher ?? null,
  };
}

// One pass over the template, so a title that holds "{lead}" stays as it is.
function vectorText(template: string, title: string, lead: string): string {
  return template.replaceAll(/\{(title|lead)\}/gu, (_, name) =>
    name === 'title' ? title : lead,
  );
}
