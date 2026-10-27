// The vector table has no document with this id.
export class UnknownDocumentError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`The vector table has no document with the id ${id}.`);
    this.name = 'UnknownDocumentError';
    this.id = id;
  }
}
