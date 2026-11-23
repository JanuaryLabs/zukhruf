/**
 * A postprocessor that compares vectors got a passage without one: the call
 * did not ask for vectors with `includeVectors: true`.
 */
export class VectorMissingError extends Error {
  override readonly name = 'VectorMissingError';
  readonly passageId: string;

  constructor(passageId: string) {
    super(
      `The passage ${passageId} has no vector: retrieve with includeVectors: true`,
    );
    this.passageId = passageId;
  }
}
