// How many workers a pool has in each state, and how many jobs wait for one,
// at the moment of the read. A worker that exited is in no count.
export interface PoolStats {
  // Workers that start and are not ready yet.
  readonly starting: number;
  // Ready workers that no job has.
  readonly idle: number;
  // Ready workers that a job has.
  readonly lent: number;
  // Jobs that wait for a worker: in the queue, or for a worker that starts.
  readonly waiting: number;
}
