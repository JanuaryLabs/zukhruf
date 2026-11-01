// Round-1 vector text (event-detector.ts analyse + lead.ts leadOf), with the
// lead rule of design 3152b, which holds round #3130's lead rule.
import { design3152b } from '/Users/ezzabuzaid/Desktop/experiments/mutex/packages/information-filtering/event-detection/src/design-3152b.ts';
import { leadOf } from '/Users/ezzabuzaid/Desktop/experiments/mutex/packages/information-filtering/event-detection/src/lead.ts';

export function vectorText(title: string, body: string): { text: string; fallback: boolean; lead: string } {
  const lead = leadOf(title, body, design3152b.lead);
  if (lead.title === null || lead.sentences.length === 0)
    return { text: `title: ${title} | text: ${title}`, fallback: true, lead: '' };
  return {
    text: `title: ${lead.title} | text: ${lead.title}\n${lead.sentences.join(' ')}`,
    fallback: false,
    lead: lead.sentences.join(' '),
  };
}
