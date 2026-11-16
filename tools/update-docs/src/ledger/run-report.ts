import { readFile } from 'node:fs/promises';

import { ReportInvalid } from '../errors.ts';
import type { BlockedItem, OpenItem, QueuedCandidate } from './items.ts';
import { Items } from './items.ts';
import { ROOT, Shape } from './shape.ts';

export interface CommittedChange {
  readonly sha: string;
  readonly subject: string;
}

/** What the lead agent of a run reports when the run ends. */
export class RunReport {
  readonly committed: readonly CommittedChange[];
  readonly queued: readonly QueuedCandidate[];
  readonly blocked: readonly BlockedItem[];
  readonly open: readonly OpenItem[];
  /** The report as written, kept beside the ledger as the run's record. */
  readonly text: string;

  private constructor(
    text: string,
    fields: Pick<RunReport, 'committed' | 'queued' | 'blocked' | 'open'>,
  ) {
    this.text = text;
    this.committed = fields.committed;
    this.queued = fields.queued;
    this.blocked = fields.blocked;
    this.open = fields.open;
  }

  static async read(file: string): Promise<RunReport> {
    const text = await readFile(file, 'utf8');
    const fail = (path: string, problem: string) =>
      new ReportInvalid(file, path, problem);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw fail('the document', `not JSON (${error.message})`);
      }
      throw error;
    }
    const shape = new Shape(fail);
    const items = new Items(shape);
    const report = shape.object(value, ROOT, [
      'committed',
      'queued',
      'blocked',
      'open',
    ]);
    const blocked = items.blocked(report.get('blocked'), 'blocked');
    const open = items.open(report.get('open'), 'open');
    for (const [index, item] of open.entries()) {
      if (
        blocked.some(
          ({ title, target }) => title === item.title && target === item.target,
        )
      ) {
        throw fail(
          `open[${index}]`,
          'an item is either open or blocked; this one is listed in both',
        );
      }
    }
    return new RunReport(text, {
      committed: shape.list(
        report.get('committed'),
        'committed',
        (each, at) => {
          const change = shape.object(each, at, ['sha', 'subject']);
          return {
            sha: shape.text(change.get('sha'), `${at}.sha`),
            subject: shape.text(change.get('subject'), `${at}.subject`),
          };
        },
      ),
      queued: items.queued(report.get('queued'), 'queued'),
      blocked,
      open,
    });
  }
}
