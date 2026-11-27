import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { threads } from '../../testing/contract/threads.ts';
import { subject, threadSharing } from '../../testing/subjects/thread.ts';

lockStore(subject);
looksTakeNoToken(subject);
threads(subject, threadSharing);
