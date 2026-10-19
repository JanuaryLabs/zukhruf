import {
  DeletionPolicy,
  type VanishedRecord,
  type Verdict,
} from './deletion-policy.ts';
import { isTimestamp } from './timestamp.ts';

// An upstream that keeps records from a horizon on and drops older ones
// without a deletion, as a time to live does: a key that vanished with an
// expiry before the horizon expired, any other was deleted.
export class Retention extends DeletionPolicy {
  readonly horizon: string;

  constructor(horizon: string) {
    super();
    if (!isTimestamp(horizon))
      throw new TypeError(`Retention horizon ${horizon} is not a timestamp`);
    this.horizon = horizon;
  }

  override vanished({ expiresBy }: VanishedRecord): Verdict {
    return expiresBy === undefined || expiresBy >= this.horizon
      ? 'deleted'
      : 'expired';
  }
}
