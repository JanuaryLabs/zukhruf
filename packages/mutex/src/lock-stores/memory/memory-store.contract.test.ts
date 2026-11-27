import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { subject } from '../../testing/subjects/memory.ts';

lockStore(subject);
looksTakeNoToken(subject);
