import { durableTokens } from '../../testing/contract/durable-tokens.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { processes } from '../../testing/contract/processes.ts';
import { leaseLoss } from '../../testing/contract/sessions.ts';
import { threads } from '../../testing/contract/threads.ts';
import {
  partitionable,
  sharing,
  subject,
  threadSharing,
} from '../../testing/subjects/docker-engine.ts';

lockStore(subject);
durableTokens(subject);
processes(subject, sharing);
threads(subject, threadSharing);
leaseLoss(subject, partitionable);
// No looksTakeNoToken: its tokens follow the clock of the engine, so the next token is not the last + 1; its rule 'isHeld tells a held key from a free one and creates nothing' proves that a look mints no rung.
