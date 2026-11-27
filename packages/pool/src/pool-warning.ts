import { brand } from './errors.ts';

/** The subject of a `PoolWarning`, by its code: the channel of a notify, the queue, and the job of a settle or a touch. */
export type PoolWarningSubject =
  | { readonly code: 'ZUKHRUF_POOL_NOTIFY_FAILED'; readonly channel: string }
  | {
      readonly code: 'ZUKHRUF_POOL_SETTLE_FAILED' | 'ZUKHRUF_POOL_TOUCH_FAILED';
      readonly queue: string;
      readonly job: string;
    }
  | {
      readonly code:
        | 'ZUKHRUF_POOL_QUEUE_ERROR'
        | 'ZUKHRUF_POOL_NOTIFICATIONS_ERROR'
        | 'ZUKHRUF_POOL_OWNER_CONNECTION_ERROR'
        | 'ZUKHRUF_POOL_FETCH_FAILED'
        | 'ZUKHRUF_POOL_REVISIONS_READ_FAILED'
        | 'ZUKHRUF_POOL_CALLER_PRESENCE_REMOVE_FAILED'
        | 'ZUKHRUF_POOL_CALLER_CONNECTION_ERROR';
      readonly queue: string;
    };

// What failed, and what the pool does next.
const MESSAGES: Readonly<Record<PoolWarningSubject['code'], string>> = {
  ZUKHRUF_POOL_QUEUE_ERROR:
    'The queue of the store failed, and the pool goes on',
  ZUKHRUF_POOL_NOTIFICATIONS_ERROR:
    'The notifications of the store failed, and the backstop finds the lost wakes',
  ZUKHRUF_POOL_NOTIFY_FAILED:
    'A notify failed, and the backstop finds the lost wake',
  ZUKHRUF_POOL_OWNER_CONNECTION_ERROR:
    'The connection of an owner broke, and the pool drops it',
  ZUKHRUF_POOL_CALLER_PRESENCE_REMOVE_FAILED:
    'The removal of the presence file of a gone caller failed, and the file stays for the next owner that finds the caller gone',
  ZUKHRUF_POOL_REVISIONS_READ_FAILED:
    'A read of the revisions in the store failed, and the next turn reads again',
  ZUKHRUF_POOL_FETCH_FAILED:
    'A fetch failed, and the owner waits for the backstop',
  ZUKHRUF_POOL_SETTLE_FAILED:
    'A settle failed, and the job lapses by its heartbeat',
  ZUKHRUF_POOL_TOUCH_FAILED: 'A touch failed, and the next touch tries again',
  ZUKHRUF_POOL_CALLER_CONNECTION_ERROR:
    'The connection to a caller broke, and the owner treats the caller as gone',
};

/**
 * A failure of the store that no caller waits for: the host goes on, and the
 * next pass, fetch, touch or backstop tries again, as pg-boss emits the
 * failure of a pass and keeps polling. Its code names the condition.
 */
export class PoolWarning extends Error {
  readonly code: PoolWarningSubject['code'];
  readonly detail: string;

  constructor(failure: unknown, subject: PoolWarningSubject) {
    super(
      `${MESSAGES[subject.code]}: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'PoolWarning';
    this.code = subject.code;
    if ('channel' in subject) {
      this.detail = `channel: ${subject.channel}`;
    } else if ('job' in subject) {
      this.detail = `queue: ${subject.queue}\njob: ${subject.job}`;
    } else {
      this.detail = `queue: ${subject.queue}`;
    }
  }
}
brand(PoolWarning, 'PoolWarning');
