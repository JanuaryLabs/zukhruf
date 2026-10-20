/** The base of every error of the package. */
export class DockerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerError';
  }
}

/** The engine did not accept the connection: its socket does not exist, or it refuses the connection. */
export class ConnectionFailedError extends DockerError {
  readonly host: string;

  constructor(host: string, options?: ErrorOptions) {
    super(`Cannot connect to the engine at ${host}.`, options);
    this.name = 'ConnectionFailedError';
    this.host = host;
  }
}

/** The host is not unix://, npipe:// or ssh://. */
export class UnsupportedHostError extends DockerError {
  readonly host: string;

  constructor(host: string) {
    super(
      `The host ${JSON.stringify(host)} is not supported: use a unix://, npipe:// or ssh:// host.`,
    );
    this.name = 'UnsupportedHostError';
    this.host = host;
  }
}

/** The context store does not have the context. */
export class ContextNotFoundError extends DockerError {
  readonly context: string;

  constructor(context: string, options?: ErrorOptions) {
    super(
      `The context store does not have the context ${JSON.stringify(context)}.`,
      options,
    );
    this.name = 'ContextNotFoundError';
    this.context = context;
  }
}

/** The highest API version of the engine is lower than the lowest one that the package supports. */
export class UnsupportedEngineError extends DockerError {
  readonly host: string;
  /** The highest API version of the engine. */
  readonly engineVersion: string;
  /** The lowest API version that the package supports. */
  readonly minimumVersion: string;

  constructor(host: string, engineVersion: string, minimumVersion: string) {
    super(
      `The engine at ${host} has API version ${engineVersion}, but the package needs ${minimumVersion} or higher. Update Docker.`,
    );
    this.name = 'UnsupportedEngineError';
    this.host = host;
    this.engineVersion = engineVersion;
    this.minimumVersion = minimumVersion;
  }
}

export interface EngineRequest {
  /** The HTTP status; undefined for an error in the progress of a pull, a push or a load. */
  status: number | undefined;
  method: string;
  path: string;
}

/** The base of every answer of the engine that is an error. Its message is the message of the engine. */
export class DockerEngineError extends DockerError {
  /** The HTTP status; undefined for an error in the progress of a pull, a push or a load. */
  readonly status: number | undefined;
  readonly method: string;
  readonly path: string;

  constructor(message: string, request: EngineRequest, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerEngineError';
    this.status = request.status;
    this.method = request.method;
    this.path = request.path;
  }
}
