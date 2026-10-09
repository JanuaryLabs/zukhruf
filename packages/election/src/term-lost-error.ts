/**
 * The term ended while its leader still ran: the backend took the claim
 * away, for example because a lease expired. Another candidate may lead now.
 */
export class TermLostError extends Error {
  constructor(options?: ErrorOptions) {
    super('This leader lost its term while it still ran.', options);
    this.name = 'TermLostError';
  }
}
