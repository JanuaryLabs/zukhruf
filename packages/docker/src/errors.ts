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

/** The method and the path of a request of the Engine API, without the API version and the query. */
export interface EngineRequest {
  readonly method: string;
  readonly path: string;
}

/** The answer that is an error: its status and the request that got it. A DockerEngineError is one too. */
export interface EngineAnswer {
  /** The HTTP status; undefined for an error in the progress of a pull, a push or a load. */
  readonly status: number | undefined;
  readonly request: EngineRequest;
}

/** The base of every answer of the engine that is an error. Its message is the message of the engine. */
export class DockerEngineError extends DockerError {
  /** The HTTP status; undefined for an error in the progress of a pull, a push or a load. */
  readonly status: number | undefined;
  /** The request that got the error. */
  readonly request: EngineRequest;

  constructor(message: string, answer: EngineAnswer, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerEngineError';
    this.status = answer.status;
    this.request = Object.freeze({
      method: answer.request.method,
      path: answer.request.path,
    });
  }
}

/** A request about a container got 404, or a start got 409 and an inspect found the removal of the container in progress. */
export class ContainerNotFoundError extends DockerEngineError {
  readonly container: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    container: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
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
    answer: EngineAnswer,
    container: string,
    state: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'ContainerNotRunningError';
    this.container = container;
    this.state = state;
  }
}

/** A create of a container, network or volume found the name taken. */
export class NameConflictError extends DockerEngineError {
  readonly kind: 'container' | 'network' | 'volume';
  /** The name that another resource has. Not `name`: that is the name of the error class. */
  readonly takenName: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    kind: 'container' | 'network' | 'volume',
    takenName: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'NameConflictError';
    this.kind = kind;
    this.takenName = takenName;
  }
}

/** A removal without `force` got 409, and an inspect showed that the container runs. */
export class ContainerRunningError extends DockerEngineError {
  readonly container: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    container: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'ContainerRunningError';
    this.container = container;
  }
}

/** A create got 404 and the image is not on the engine, a pull got 404, or a push found no image of the reference on the engine. */
export class ImageNotFoundError extends DockerEngineError {
  readonly image: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    image: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'ImageNotFoundError';
    this.image = image;
  }
}

/** A start got 404 while the container exists, and a lookup of its networks found one missing; or a request about a network got 404. */
export class NetworkNotFoundError extends DockerEngineError {
  readonly network: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    network: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'NetworkNotFoundError';
    this.network = network;
  }
}

/** A request about a volume got 404. */
export class VolumeNotFoundError extends DockerEngineError {
  readonly volume: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    volume: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'VolumeNotFoundError';
    this.volume = volume;
  }
}

/** A volume removal got 409: a container uses the volume. */
export class VolumeInUseError extends DockerEngineError {
  readonly volume: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    volume: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'VolumeInUseError';
    this.volume = volume;
  }
}

/** A network removal got 403 while containers are connected. */
export class NetworkInUseError extends DockerEngineError {
  readonly network: string;
  /** The IDs of the connected containers, from an inspect after the 403. */
  readonly containers: string[];

  constructor(
    message: string,
    answer: EngineAnswer,
    network: string,
    containers: string[],
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'NetworkInUseError';
    this.network = network;
    this.containers = containers;
  }
}

/** An image removal got 409. */
export class ImageInUseError extends DockerEngineError {
  readonly image: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    image: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'ImageInUseError';
    this.image = image;
  }
}

/** A create or a start refused a bind mount whose source does not exist on the host of the engine. */
export class BindSourceNotFoundError extends DockerEngineError {
  /** The path on the host of the engine. */
  readonly source: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    source: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'BindSourceNotFoundError';
    this.source = source;
  }
}

/** A file request got 404, and the container exists. */
export class PathNotFoundError extends DockerEngineError {
  readonly container: string;
  /** The path in the container. */
  readonly path: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    container: string,
    path: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'PathNotFoundError';
    this.container = container;
    this.path = path;
  }
}

/** readFile() found a directory, a link or another kind of entry. */
export class NotAFileError extends DockerEngineError {
  readonly container: string;
  /** The path in the container. */
  readonly path: string;
  /** The kind of the entry: 'directory', 'symlink', 'link' or 'other'. */
  readonly kind: 'directory' | 'symlink' | 'link' | 'other';

  constructor(
    message: string,
    answer: EngineAnswer,
    container: string,
    path: string,
    kind: 'directory' | 'symlink' | 'link' | 'other',
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'NotAFileError';
    this.container = container;
    this.path = path;
    this.kind = kind;
  }
}

/** The engine refused an extraction, and an inspect showed that the directory is on a read-only root filesystem or in a read-only mount. */
export class ReadOnlyPathError extends DockerEngineError {
  readonly container: string;
  /** The path in the container. */
  readonly path: string;

  constructor(
    message: string,
    answer: EngineAnswer,
    container: string,
    path: string,
    options?: ErrorOptions,
  ) {
    super(message, answer, options);
    this.name = 'ReadOnlyPathError';
    this.container = container;
    this.path = path;
  }
}
