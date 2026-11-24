/** The removal of a lost claim failed for a reason other than an engine out of reach. The claim ends with its attach. */
export class DockerEngineStoreWarning extends Error {
  readonly code = 'ZUKHRUF_MUTEX_DOCKER_CLAIM_REMOVE_FAILED';
  readonly detail: string;

  constructor(
    failure: unknown,
    { key, container }: { key: string; container: string },
  ) {
    super(
      `The removal of a lost claim failed, and the claim ends with its attach: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'DockerEngineStoreWarning';
    this.detail = `key: ${key}\ncontainer: ${container}`;
  }
}
