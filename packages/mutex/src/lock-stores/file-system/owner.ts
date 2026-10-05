import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { isErrno } from '../../shared/fs/errno.ts';

/**
 * Identifies one lock request and the process that made it, so waiters can
 * evict a holder whose process died. A reused pid only delays recovery; it
 * never breaks exclusion. Holders on another host are never evicted.
 */
export class Owner {
  readonly pid: number;
  readonly host: string;
  readonly id: string;

  constructor(pid: number, host: string, id: string) {
    this.pid = pid;
    this.host = host;
    this.id = id;
  }

  static current(): Owner {
    return new Owner(process.pid, hostname(), randomUUID());
  }

  static parse(serialized: string): Owner {
    const { pid, host, id } = JSON.parse(serialized) as Pick<
      Owner,
      'pid' | 'host' | 'id'
    >;
    return new Owner(pid, host, id);
  }

  serialize(): string {
    return JSON.stringify({ pid: this.pid, host: this.host, id: this.id });
  }

  isAlive(): boolean {
    if (this.host !== hostname()) return true;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch (error) {
      return !isErrno(error, 'ESRCH');
    }
  }
}
