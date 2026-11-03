import { durableTokens } from '../../testing/contract/durable-tokens.ts';
import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { onDisk, passiveLooks } from '../../testing/contract/on-disk.ts';
import { processes } from '../../testing/contract/processes.ts';
import { threads } from '../../testing/contract/threads.ts';
import {
  disk,
  sharing,
  subject,
  threadSharing,
} from '../../testing/subjects/sqlite.ts';

lockStore(subject);
looksTakeNoToken(subject);
durableTokens(subject);
processes(subject, sharing);
threads(subject, threadSharing);
onDisk(subject, disk);
passiveLooks(subject, disk, sharing);
