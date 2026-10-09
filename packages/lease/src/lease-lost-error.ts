/** The holder may have lost the right to its subject: another holder may have it now. */
export class LeaseLostError extends Error {
  readonly subject: string;

  constructor(subject: string, options?: ErrorOptions) {
    super(
      `Lost the lease on ${JSON.stringify(subject)}: another holder may have it now.`,
      options,
    );
    this.name = 'LeaseLostError';
    this.subject = subject;
  }
}
