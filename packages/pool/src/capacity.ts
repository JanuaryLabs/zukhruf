import { availableParallelism } from 'node:os';

// The workers this Mac affords: one per CPU, as long as each still finds its
// memory free.
export function capacity(memoryPerWorker: number): number {
  return Math.max(
    1,
    Math.min(
      availableParallelism(),
      Math.floor(process.availableMemory() / memoryPerWorker),
    ),
  );
}
