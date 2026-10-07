import { EventEmitter } from 'node:events';

import type { Connection, ConnectionEvents } from '../remote/connection.ts';
import {
  ADDED_OPS,
  type LockRequest,
  type LockResponse,
} from '../remote/protocol.ts';

/**
 * A follower's connection to a leader, which sends an added request only if
 * the leader listed it in its welcome. A leader of 0.3.x closes a connection
 * that sends a request it does not know, and the follower would lose every key
 * it holds; such a request is answered `unsupported` here instead.
 */
export class AdvertisedOpsConnection
  extends EventEmitter<ConnectionEvents<LockResponse>>
  implements Connection<LockRequest, LockResponse>
{
  readonly #leader: Connection<LockRequest, LockResponse>;
  readonly #listed: ReadonlySet<string>;

  constructor(
    leader: Connection<LockRequest, LockResponse>,
    listed: ReadonlySet<string>,
  ) {
    super();
    this.#leader = leader;
    this.#listed = listed;
    leader.on('message', (response) => this.emit('message', response));
    leader.once('close', () => this.emit('close'));
  }

  async send(request: LockRequest): Promise<void> {
    if (ADDED_OPS.has(request.op) && !this.#listed.has(request.op)) {
      // Answered after the send returns, as an answer from the leader would be.
      queueMicrotask(() =>
        this.emit('message', { op: 'unsupported', id: request.id }),
      );
      return;
    }
    await this.#leader.send(request);
  }

  ref() {
    this.#leader.ref();
  }

  unref() {
    this.#leader.unref();
  }

  close() {
    this.#leader.close();
  }
}
