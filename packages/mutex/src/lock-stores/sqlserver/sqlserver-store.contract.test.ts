import { durableTokens } from '../../testing/contract/durable-tokens.ts';
import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { processes } from '../../testing/contract/processes.ts';
import { leaseLoss, sessions } from '../../testing/contract/sessions.ts';
import { threads } from '../../testing/contract/threads.ts';
import {
  partitionable,
  sessionControl,
  sharing,
  subject,
  threadSharing,
} from '../../testing/subjects/sqlserver.ts';

lockStore(subject);
looksTakeNoToken(subject);
durableTokens(subject);
processes(subject, sharing);
threads(subject, threadSharing);
leaseLoss(subject, partitionable);
sessions(subject, sessionControl);
