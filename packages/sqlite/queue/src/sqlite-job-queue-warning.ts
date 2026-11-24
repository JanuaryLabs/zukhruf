// What failed, and who did not hear it.
const MESSAGES = {
  ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD:
    "The fail of a worker's active jobs at stop failed, and nobody listens for 'error'",
  ZUKHRUF_SQLITE_QUEUE_ERROR_LISTENER_THREW:
    "The fail of a worker's active jobs at stop failed, and an 'error' listener threw",
} as const;

/**
 * At a stop, the fail of a worker's active jobs failed, and its `'error'`
 * reached no listener, or a listener threw. The other workers still stop.
 */
export class SqliteJobQueueWarning extends Error {
  readonly code: keyof typeof MESSAGES;
  readonly detail: string;

  constructor(
    failure: unknown,
    {
      code,
      queue,
      worker,
    }: { code: keyof typeof MESSAGES; queue: string; worker: string },
  ) {
    super(
      `${MESSAGES[code]}: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'SqliteJobQueueWarning';
    this.code = code;
    this.detail = `queue: ${queue}\nworker: ${worker}`;
  }
}
