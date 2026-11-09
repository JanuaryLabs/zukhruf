/** `'granted'` once the lease is given back, or the error of the acquire. */
export const outcome = (acquiring: Promise<AsyncDisposable>) =>
  acquiring.then(
    async (lease) => {
      await lease[Symbol.asyncDispose]();
      return 'granted' as const;
    },
    (error: unknown) => error,
  );

/** `'granted'` once the task ran, or its error: the task's mutex gave its lease back. */
export const taskOutcome = (running: Promise<unknown>) =>
  running.then(
    () => 'granted' as const,
    (error: unknown) => error,
  );
