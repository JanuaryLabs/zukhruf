import type {
  BundleRecord,
  EvidenceRecord,
  OmittedRecord,
  Tier,
  TranscriptRecord,
} from './record.ts';

/** The most bytes of JSONL a bundle holds, so an agent reads it whole. */
const BUDGET = 120_000;

const TIERS: readonly Tier[] = [
  'transcript:prompt',
  'consumer-commit',
  'consumer-site',
  'package-commit',
  'transcript:assistant-text',
  'transcript:tool-input',
];

/**
 * Cuts a project's records to the bundle budget, by priority: the owner's
 * prompts, consumer commits, consumer call sites, package commits, then the
 * assistant's texts and tool inputs. It fills tier by tier, newest first, and
 * stops at the first record that does not fit. A cut bundle ends with one
 * `omitted` record.
 */
export class EvidenceBudget {
  cut(records: readonly EvidenceRecord[]): BundleRecord[] {
    const ordered = TIERS.flatMap((tier) =>
      this.#ordered(records.filter((record) => tierOf(record) === tier)),
    );
    const kept: EvidenceRecord[] = [];
    let size = 0;
    for (const record of ordered) {
      const bytes = lineBytes(record);
      if (size + bytes > BUDGET) {
        break;
      }
      kept.push(record);
      size += bytes;
    }
    if (kept.length === ordered.length) {
      return kept;
    }
    // The omitted line takes room too: drop the last kept record until it fits.
    let omitted = this.#omitted(ordered, kept);
    while (size + lineBytes(omitted) > BUDGET) {
      const last = kept.pop();
      if (last === undefined) {
        break;
      }
      size -= lineBytes(last);
      omitted = this.#omitted(ordered, kept);
    }
    return [...kept, omitted];
  }

  /**
   * Newest first. Transcript texts and tool inputs go by session, the session
   * with the newest record first, so a cut drops whole older sessions.
   */
  #ordered(records: readonly EvidenceRecord[]): EvidenceRecord[] {
    const latest = new Map<string, Temporal.Instant>();
    for (const record of records) {
      if (record.source === 'transcript') {
        const seen = latest.get(record.session);
        const at = instant(record);
        if (seen === undefined || Temporal.Instant.compare(at, seen) > 0) {
          latest.set(record.session, at);
        }
      }
    }
    const bySession = (a: EvidenceRecord, b: EvidenceRecord) => {
      if (
        a.source !== 'transcript' ||
        b.source !== 'transcript' ||
        a.kind === 'prompt' ||
        a.session === b.session
      ) {
        return 0;
      }
      const [endA, endB] = [latest.get(a.session), latest.get(b.session)];
      return (
        (endA === undefined || endB === undefined
          ? 0
          : Temporal.Instant.compare(endB, endA)) ||
        a.session.localeCompare(b.session)
      );
    };
    return records.toSorted((a, b) => bySession(a, b) || newestFirst(a, b));
  }

  #omitted(
    ordered: readonly EvidenceRecord[],
    kept: readonly EvidenceRecord[],
  ): OmittedRecord {
    const left = ordered.slice(kept.length);
    const count = (tier: Tier) =>
      left.filter((record) => tierOf(record) === tier).length;
    const oldest = kept.toSorted(newestFirst).at(-1);
    return {
      source: 'omitted',
      omitted: {
        'transcript:prompt': count('transcript:prompt'),
        'consumer-commit': count('consumer-commit'),
        'consumer-site': count('consumer-site'),
        'package-commit': count('package-commit'),
        'transcript:assistant-text': count('transcript:assistant-text'),
        'transcript:tool-input': count('transcript:tool-input'),
      },
      oldestKept: oldest === undefined ? null : oldest.ts,
    };
  }
}

function tierOf(record: EvidenceRecord): Tier {
  return record.source === 'transcript'
    ? transcriptTier(record)
    : record.source;
}

function transcriptTier(record: TranscriptRecord): Tier {
  return `transcript:${record.kind}`;
}

/** git writes `ts` with the committer's offset, Claude Code in UTC. */
function instant(record: EvidenceRecord): Temporal.Instant {
  return Temporal.Instant.from(record.ts);
}

function newestFirst(a: EvidenceRecord, b: EvidenceRecord): number {
  return (
    Temporal.Instant.compare(instant(b), instant(a)) ||
    a.ref.localeCompare(b.ref)
  );
}

function lineBytes(record: BundleRecord): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`);
}
