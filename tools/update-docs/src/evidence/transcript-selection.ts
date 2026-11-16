import type { TranscriptRecord } from './record.ts';

const PER_SESSION = 12;

/**
 * The transcript records of one project that fit an agent's context: a
 * resumed or forked session copies its parent's lines, so a text another
 * session already gave is dropped, and each session gives at most
 * PER_SESSION records, its prompts first and then its newest others.
 */
export class TranscriptSelection {
  select(records: readonly TranscriptRecord[]): TranscriptRecord[] {
    const sessions = Map.groupBy(
      this.#unique(this.#oldestFirst(records)),
      ({ session }) => session,
    );
    return [...sessions.values()]
      .flatMap((session) => this.#capped(session))
      .toSorted(byTime);
  }

  /**
   * Oldest first. A copied line keeps its timestamp, so of two records at one
   * instant, the one of the session that ended first, the original, comes
   * first: the files are read in parallel, in no fixed order.
   */
  #oldestFirst(records: readonly TranscriptRecord[]): TranscriptRecord[] {
    const ends = new Map<string, string>();
    for (const { session, ts } of records) {
      const end = ends.get(session);
      if (end === undefined || ts > end) {
        ends.set(session, ts);
      }
    }
    const end = (record: TranscriptRecord) => ends.get(record.session) ?? '';
    return records.toSorted(
      (a, b) => byTime(a, b) || end(a).localeCompare(end(b)),
    );
  }

  /** Each text once, in the session that gave it first. */
  #unique(records: readonly TranscriptRecord[]): TranscriptRecord[] {
    const first = new Map<string, string>();
    return records.filter(({ kind, text, session }) => {
      const key = `${kind}\u{0}${text}`;
      const owner = first.get(key) ?? session;
      first.set(key, owner);
      return owner === session;
    });
  }

  /** One session's records, oldest first, as many as PER_SESSION allows. */
  #capped(session: readonly TranscriptRecord[]): TranscriptRecord[] {
    const newest = (records: readonly TranscriptRecord[], count: number) =>
      records.slice(Math.max(0, records.length - count));
    const prompts = newest(
      session.filter(({ kind }) => kind === 'prompt'),
      PER_SESSION,
    );
    const others = newest(
      session.filter(({ kind }) => kind !== 'prompt'),
      PER_SESSION - prompts.length,
    );
    return [...prompts, ...others];
  }
}

function byTime(a: TranscriptRecord, b: TranscriptRecord): number {
  return a.ts.localeCompare(b.ts);
}
