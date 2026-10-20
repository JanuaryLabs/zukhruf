export type { DockerContext, Environment } from './context-store.ts';
export { type ConnectOptions, Docker } from './docker.ts';
export {
  ConnectionFailedError,
  ContextNotFoundError,
  DockerEngineError,
  DockerError,
  UnsupportedEngineError,
  UnsupportedHostError,
} from './errors.ts';
export type { CancelOptions, Filters } from './options.ts';

/** The bodies and answers of the Engine API, with the names of its reference. Types only. */
export type * as EngineApi from './engine-api.ts';
