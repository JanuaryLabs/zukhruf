import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ContextNotFoundError } from './errors.ts';

export interface DockerContext {
  name: string;
  host: string;
  /** The context that connect() selects with no options. */
  current: boolean;
}

/** An engine as the selection gives it: the context that selected it, and its host. */
export interface SelectedEngine {
  context: string;
  host: string;
}

const DEFAULT_CONTEXT = 'default';

/** The host of the default context when DOCKER_HOST is not set. */
function platformHost(): string {
  return process.platform === 'win32'
    ? 'npipe:////./pipe/docker_engine'
    : 'unix:///var/run/docker.sock';
}

/** The environment of the host program, such as process.env. The package reads only DOCKER_HOST, DOCKER_CONTEXT and DOCKER_CONFIG. */
export type Environment = Readonly<Record<string, string | undefined>>;

type Variable = 'DOCKER_HOST' | 'DOCKER_CONTEXT' | 'DOCKER_CONFIG';

/** An empty variable is the same as an unset one, as in the Docker CLI. */
function variable(
  environment: Environment,
  name: Variable,
): string | undefined {
  const value = environment[name];
  return value === '' ? undefined : value;
}

/** The Docker configuration directory: DOCKER_CONFIG, or ~/.docker. */
function configDirectory(environment: Environment): string {
  return variable(environment, 'DOCKER_CONFIG') ?? join(homedir(), '.docker');
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/** currentContext in config.json, or undefined when the file or the field is absent. */
async function configuredContext(
  environment: Environment,
): Promise<string | undefined> {
  try {
    const config: unknown = JSON.parse(
      await readFile(join(configDirectory(environment), 'config.json'), 'utf8'),
    );
    return stringField(config, 'currentContext');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/** The context that the Docker CLI selects when a command names none. */
async function currentContext(environment: Environment): Promise<string> {
  if (variable(environment, 'DOCKER_HOST')) return DEFAULT_CONTEXT;
  return (
    variable(environment, 'DOCKER_CONTEXT') ??
    (await configuredContext(environment)) ??
    DEFAULT_CONTEXT
  );
}

/** The host of the default context: DOCKER_HOST, or the default host of the platform. */
function defaultHost(environment: Environment): string {
  return variable(environment, 'DOCKER_HOST') ?? platformHost();
}

function metaDirectory(environment: Environment): string {
  return join(configDirectory(environment), 'contexts', 'meta');
}

/** Endpoints.docker.Host of meta.json, or undefined when the context has no docker endpoint. */
function hostOfMeta(meta: unknown): string | undefined {
  const endpoints: unknown = Reflect.get(Object(meta), 'Endpoints');
  const docker: unknown = Reflect.get(Object(endpoints), 'docker');
  return stringField(docker, 'Host');
}

/** The host of a context of the context store. */
async function storedHost(
  environment: Environment,
  name: string,
): Promise<string> {
  const id = createHash('sha256').update(name).digest('hex');
  try {
    const meta: unknown = JSON.parse(
      await readFile(join(metaDirectory(environment), id, 'meta.json'), 'utf8'),
    );
    const host = hostOfMeta(meta);
    if (host === undefined) throw new ContextNotFoundError(name);
    return host;
  } catch (error) {
    if (isMissingFile(error))
      throw new ContextNotFoundError(name, { cause: error });
    throw error;
  }
}

/** The host of a context: the default context takes it from DOCKER_HOST, as the Docker CLI defines it. */
async function hostOfContext(
  environment: Environment,
  name: string,
): Promise<string> {
  return name === DEFAULT_CONTEXT
    ? defaultHost(environment)
    : storedHost(environment, name);
}

/** Selects the engine in the order of the Docker CLI, or the engine that the options name. */
export async function selectEngine(options: {
  context?: string | undefined;
  host?: string | undefined;
  environment?: Environment | undefined;
}): Promise<SelectedEngine> {
  if (options.host !== undefined) {
    return { context: DEFAULT_CONTEXT, host: options.host };
  }
  const environment = options.environment ?? {};
  const context = options.context ?? (await currentContext(environment));
  return { context, host: await hostOfContext(environment, context) };
}

/** Each context of the context store, and the default context. */
export async function listContexts(
  environment: Environment = {},
): Promise<DockerContext[]> {
  const current = await currentContext(environment);
  const stored = await storedContexts(environment);
  return [
    { name: DEFAULT_CONTEXT, host: defaultHost(environment) },
    ...stored.toSorted((left, right) => left.name.localeCompare(right.name)),
  ].map(({ name, host }) => ({ name, host, current: name === current }));
}

async function storedContexts(
  environment: Environment,
): Promise<{ name: string; host: string }[]> {
  const directory = metaDirectory(environment);
  const ids = await readdir(directory).catch((error: unknown) => {
    if (isMissingFile(error)) return [];
    throw error;
  });
  const contexts = await Promise.all(
    ids.map(async (id) => {
      const meta: unknown = JSON.parse(
        await readFile(join(directory, id, 'meta.json'), 'utf8').catch(
          (error: unknown) => {
            if (isMissingFile(error)) return 'null';
            throw error;
          },
        ),
      );
      const name = stringField(meta, 'Name');
      const host = hostOfMeta(meta);
      return name === undefined || host === undefined
        ? undefined
        : { name, host };
    }),
  );
  return contexts.filter((context) => context !== undefined);
}
