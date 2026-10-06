import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { isRecord } from '../../shared/is-record.ts';

/**
 * Identifies one request for a key and the process that made it. The process
 * ID and host name are for people who read a lock file; whether the caller
 * still runs is told by its presence.
 */
export class Caller {
  readonly pid: number;
  readonly host: string;
  readonly id: string;

  constructor(pid: number, host: string, id: string) {
    this.pid = pid;
    this.host = host;
    this.id = id;
  }

  static current(): Caller {
    return new Caller(process.pid, hostname(), randomUUID());
  }

  static parse(serialized: string): Caller {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      throw new SyntaxError(`Not a lock caller: ${serialized}`);
    }
    return new Caller(parsed.pid, parsed.host, parsed.id);
  }

  serialize(): string {
    return JSON.stringify({ pid: this.pid, host: this.host, id: this.id });
  }
}
