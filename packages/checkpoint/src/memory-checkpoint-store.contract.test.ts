import { MemoryCheckpointStore } from './index.ts';
import { checkpointStoreContract } from './testing/contract/checkpoint-store.ts';

checkpointStoreContract({
  name: 'MemoryCheckpointStore',
  open: async () => ({
    store: new MemoryCheckpointStore(),
    [Symbol.asyncDispose]: async () => {},
  }),
});
