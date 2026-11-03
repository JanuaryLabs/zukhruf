import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { processes } from '../../testing/contract/processes.ts';
import { sharing, subject } from '../../testing/subjects/ipc.ts';

lockStore(subject);
looksTakeNoToken(subject);
processes(subject, sharing);
