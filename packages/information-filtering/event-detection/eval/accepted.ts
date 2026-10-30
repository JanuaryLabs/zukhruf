import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalSet } from './answer-key.ts';
import type { Partition } from './metrics/contingency.ts';

// The events of each accepted design, so that a later run can resample the
// same reports for both designs (bootstrap.ts). One file for each design.
// events[i] is the event of the answer-key row i, or null when the report
// was not scored; the numbers are in the order of first appearance.
const ACCEPTED_FOLDER = join(import.meta.dirname, 'accepted');

type Events = {
  readonly labelsSha256: string;
  readonly events: readonly (number | null)[];
};

export function writeEvents(
  design: string,
  sets: readonly { readonly set: EvalSet; readonly eventOf: Partition }[],
): void {
  mkdirSync(ACCEPTED_FOLDER, { recursive: true });
  const lines = sets.map(({ set, eventOf }) => {
    const number = new Map<string, number>();
    const events = set.rows.map((row) => {
      const event = eventOf.get(row.id);
      if (event === undefined) return null;
      if (!number.has(event)) number.set(event, number.size);
      return number.get(event)!;
    });
    const value: Events = { labelsSha256: set.metadata.labelsSha256, events };
    return `    ${JSON.stringify(set.name)}: ${JSON.stringify(value)}`;
  });
  writeFileSync(
    join(ACCEPTED_FOLDER, `${design}.json`),
    `{\n  "design": ${JSON.stringify(design)},\n  "sets": {\n${lines.join(',\n')}\n  }\n}\n`,
  );
}

// The events of the design on the set, or null when the design has none on
// these labels.
export function readEvents(design: string, set: EvalSet): Partition | null {
  const file = join(ACCEPTED_FOLDER, `${design}.json`);
  if (!existsSync(file)) return null;
  const { sets }: { sets: Record<string, Events> } = JSON.parse(
    readFileSync(file, 'utf8'),
  );
  const stored = sets[set.name];
  if (stored === undefined || stored.labelsSha256 !== set.metadata.labelsSha256)
    return null;
  return new Map(
    set.rows.flatMap((row, index) => {
      const event = stored.events[index];
      return event === null || event === undefined
        ? []
        : [[row.id, String(event)] as const];
    }),
  );
}
