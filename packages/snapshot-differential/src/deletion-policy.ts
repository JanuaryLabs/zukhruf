export type KeyValue = string | number | boolean;

// A key the last committed scan saw and this scan did not.
export type VanishedRecord = {
  readonly key: Readonly<Record<string, KeyValue>>;
  // When the upstream drops the record, as last seen, when the snapshot keeps it.
  readonly expiresBy?: string;
};

// deleted: the upstream deleted the record (the closed-world assumption).
// unknown: the scan cannot tell (the open-world assumption); the key stays in
// the snapshot, and the next scan asks again.
// expired: the upstream dropped the record for good without a deletion, as a
// time to live does; the key leaves the snapshot.
export type Verdict = 'deleted' | 'unknown' | 'expired';

// The Strategy a snapshot differential asks about each vanished key.
export abstract class DeletionPolicy {
  abstract vanished(record: VanishedRecord): Verdict;
}
