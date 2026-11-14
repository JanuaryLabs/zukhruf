/** A call of `listen`, `unlisten` or `notify` after dispose. .NET's ObjectDisposedException. */
export class DisposedError extends Error {
  constructor() {
    super(
      'The notifications are disposed: they listen and send no more. Make a new Notifications.',
    );
    this.name = 'DisposedError';
  }
}
