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

/** A request about a container got 404. */
export class ContainerNotFoundError extends DockerEngineError {
  readonly container: string;

  constructor(
    message: string,
    request: EngineRequest,
    container: string,
    options?: ErrorOptions,
  ) {
    super(message, request, options);
    this.name = 'ContainerNotFoundError';
    this.container = container;
  }
}

/** An exec or a kill got 409, or an attach found the container exited or paused. */
export class ContainerNotRunningError extends DockerEngineError {
  readonly container: string;
  /** From an inspect after the 409: 'created', 'exited', 'paused', 'restarting', 'removing' or 'dead'. */
  readonly state: string;

  constructor(
    message: string,
    request: EngineRequest,
    container: string,
    state: string,
    options?: ErrorOptions,
  ) {
    super(message, request, options);
    this.name = 'ContainerNotRunningError';
    this.container = container;
    this.state = state;
  }
}

/**
 * A create of a container, network or volume found the name taken. Its `name`
 * is the taken name, so it replaces the class name of Error.
 */
export class NameConflictError extends DockerEngineError {
  readonly kind: 'container' | 'network' | 'volume';
  /** The taken name. */
  override readonly name: string;

  constructor(
    message: string,
    request: EngineRequest,
    kind: 'container' | 'network' | 'volume',
    name: string,
    options?: ErrorOptions,
  ) {
    super(message, request, options);
    this.kind = kind;
    this.name = name;
  }
}

/** A create got 404 and the image is not on the engine, or a pull got 404. */
export class ImageNotFoundError extends DockerEngineError {
  readonly image: string;

  constructor(
    message: string,
    request: EngineRequest,
    image: string,
    options?: ErrorOptions,
  ) {
    super(message, request, options);
    this.name = 'ImageNotFoundError';
    this.image = image;
  }
}

/** A request needs a network that the engine does not have. */
export class NetworkNotFoundError extends DockerEngineError {
  readonly network: string;

  constructor(
    message: string,
    request: EngineRequest,
    network: string,
    options?: ErrorOptions,
  ) {
    super(message, request, options);
    this.name = 'NetworkNotFoundError';
    this.network = network;
  }
}

/** A create or a start refused a bind mount whose source does not exist on the host of the engine. */
export class BindSourceNotFoundError extends DockerEngineError {
  /** The path on the host of the engine. */
  readonly source: string;

  constructor(
    message: string,
    request: EngineRequest,
    source: string,
    options?: ErrorOptions,
  ) {
    super(message, request, options);
    this.name = 'BindSourceNotFoundError';
    this.source = source;
  }
}
