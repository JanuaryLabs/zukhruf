// The two reads of the computer that the capacity needs. Production gives the
// functions of Node: availableParallelism of node:os and availableMemory of
// process; both work without their object.
export interface Computer {
  availableParallelism(): number;
  availableMemory(): number;
}

export interface CapacityOptions {
  readonly memoryPerWorker: number;
  readonly computer: Computer;
}

// The workers the computer affords: one per CPU, as long as each still finds
// its memory free.
export function capacity({
  memoryPerWorker,
  computer,
}: CapacityOptions): number {
  return Math.max(
    1,
    Math.min(
      computer.availableParallelism(),
      Math.floor(computer.availableMemory() / memoryPerWorker),
    ),
  );
}
