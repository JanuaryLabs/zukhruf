/** The modules that a child process's source imports by URL. */
export const mutexUrl = new URL('../mutex/mutex.ts', import.meta.url);
export const modesUrl = new URL(
  '../mutex/acquire-modes/modes.ts',
  import.meta.url,
);
