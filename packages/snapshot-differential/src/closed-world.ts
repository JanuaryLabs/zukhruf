import { DeletionPolicy, type Verdict } from './deletion-policy.ts';

// A scan that lists every record: a key it does not list was deleted.
export class ClosedWorld extends DeletionPolicy {
  override vanished(): Verdict {
    return 'deleted';
  }
}
