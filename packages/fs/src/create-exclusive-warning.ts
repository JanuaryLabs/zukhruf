/** `createExclusive` has its answer, and the removal of its draft failed. The draft stays. */
export class CreateExclusiveWarning extends Error {
  readonly code = 'ZUKHRUF_FS_DRAFT_REMOVE_FAILED';
  readonly detail: string;

  constructor(failure: unknown, { draft }: { draft: string }) {
    super(
      `The removal of the draft failed, and the draft stays: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'CreateExclusiveWarning';
    this.detail = `draft: ${draft}`;
  }
}
