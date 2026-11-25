import { open } from 'node:fs/promises';

import type { Client } from '../client.ts';
import { Preflight } from '../preflight.ts';
import { Service } from '../service.ts';

const denials = new Set(['EPERM', 'EACCES']);
const absences = new Set(['ENOENT', 'ENOTDIR']);

type Outcome = 'readable' | 'denied' | 'missing';

// Full Disk Access has no status: Apple gives no API for it and no path that
// proves the grant (ADR 0003). The caller preflights the paths of its work.
export class FullDiskAccess extends Service {
  readonly name = 'kTCCServiceSystemPolicyAllFiles';
  readonly pane = 'Full Disk Access';
  protected readonly anchor = 'Privacy_AllFiles';

  // A grant of Full Disk Access applies to the processes that start after it.
  override remedy(client: Client): string {
    const again =
      client.type === 'bundle'
        ? `quit and reopen ${client.name}`
        : 'start it again';
    return `Turn on ${client.name} in System Settings › Privacy & Security › ${this.pane}, then ${again}. macOS does not ask for this access.`;
  }

  async preflight(paths: readonly string[]): Promise<Preflight> {
    const outcomes = await Promise.all(paths.map((path) => outcome(path)));
    const of = (kind: Outcome) =>
      paths.filter((_, index) => outcomes[index] === kind);
    return new Preflight(of('readable'), of('denied'), of('missing'));
  }
}

async function outcome(path: string): Promise<Outcome> {
  try {
    const handle = await open(path, 'r');
    await handle.close();
    return 'readable';
  } catch (error) {
    const code = Error.isError(error) && 'code' in error ? error.code : '';
    if (typeof code === 'string' && denials.has(code)) return 'denied';
    if (typeof code === 'string' && absences.has(code)) return 'missing';
    throw error;
  }
}
