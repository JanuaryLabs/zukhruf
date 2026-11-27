/** A notification's method failed on this end. Nothing answers a notification, so the failure goes to the process. */
export class ServerWarning extends Error {
  readonly code = 'ZUKHRUF_RPC_NOTIFICATION_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { method }: { method: string }) {
    super(
      `A notification's method failed, and the server goes on: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'ServerWarning';
    this.detail = `method: ${method}`;
  }
}
