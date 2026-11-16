/** One line of an evidence bundle: a found record, or the cut's summary. */
export type BundleRecord = EvidenceRecord | OmittedRecord;

/** One record a reader found; `source` tells which reader. */
export type EvidenceRecord =
  | PackageCommitRecord
  | ConsumerSiteRecord
  | ConsumerCommitRecord
  | TranscriptRecord;

interface Found {
  readonly ts: string;
  readonly ref: string;
  readonly text: string;
}

export interface PackageCommitRecord extends Found {
  readonly source: 'package-commit';
}

export interface ConsumerSiteRecord extends Found {
  readonly source: 'consumer-site';
  readonly repo: string;
}

export interface ConsumerCommitRecord extends Found {
  readonly source: 'consumer-commit';
  readonly repo: string;
}

export interface TranscriptRecord extends Found {
  readonly source: 'transcript';
  /** Only a prompt carries the user's own words. */
  readonly kind: 'prompt' | 'tool-input' | 'assistant-text';
  readonly session: string;
  readonly cwd: string;
}

/** The tiers a bundle cut fills, highest priority first. */
export type Tier =
  | 'transcript:prompt'
  | 'consumer-commit'
  | 'consumer-site'
  | 'package-commit'
  | 'transcript:assistant-text'
  | 'transcript:tool-input';

/**
 * The last line of a bundle the size budget cut: how many records of each
 * tier were left out, and the `ts` of the oldest record kept, or null when no
 * record fit.
 */
export interface OmittedRecord {
  readonly source: 'omitted';
  readonly omitted: Readonly<Record<Tier, number>>;
  readonly oldestKept: string | null;
}
