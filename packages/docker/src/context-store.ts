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

/** An empty variable is the same as an unset one, as in the Docker CLI. */
function variable(name: string): string | undefined {
  // eslint-disable-next-line island/no-process-env -- The package selects the engine as the Docker CLI does, and the CLI reads DOCKER_HOST, DOCKER_CONTEXT and DOCKER_CONFIG from the environment (ADR 0002).
  const value = process.env[name];
  return value === '' ? undefined : value;
}

/** The Docker configuration directory: DOCKER_CONFIG, or ~/.docker. */
function configDirectory(): string {
  return variable('DOCKER_CONFIG') ?? join(homedir(), '.docker');
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
async function configuredContext(): Promise<string | undefined> {
  try {
    const config: unknown = JSON.parse(
      await readFile(join(configDirectory(), 'config.json'), 'utf8'),
    );
    return stringField(config, 'currentContext');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/** The context that the Docker CLI selects when a command names none. */
async function currentContext(): Promise<string> {
  if (variable('DOCKER_HOST')) return DEFAULT_CONTEXT;
  return (
    variable('DOCKER_CONTEXT') ?? (await configuredContext()) ?? DEFAULT_CONTEXT
  );
}

/** The host of the default context: DOCKER_HOST, or the default host of the platform. */
function defaultHost(): string {
  return variable('DOCKER_HOST') ?? platformHost();
}

function metaDirectory(): string {
  return join(configDirectory(), 'contexts', 'meta');
}

/** Endpoints.docker.Host of meta.json, or undefined when the context has no docker endpoint. */
function hostOfMeta(meta: unknown): string | undefined {
  const endpoints: unknown = Reflect.get(Object(meta), 'Endpoints');
  const docker: unknown = Reflect.get(Object(endpoints), 'docker');
  return stringField(docker, 'Host');
}

/** The host of a context of the context store. */
async function storedHost(name: string): Promise<string> {
  const id = createHash('sha256').update(name).digest('hex');
  try {
    const meta: unknown = JSON.parse(
      await readFile(join(metaDirectory(), id, 'meta.json'), 'utf8'),
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

async function hostOfContext(name: string): Promise<string> {
  return name === DEFAULT_CONTEXT ? defaultHost() : storedHost(name);
}

/** Selects the engine in the order of the Docker CLI, or the engine that the options name. */
export async function selectEngine(options: {
  context?: string | undefined;
  host?: string | undefined;
}): Promise<SelectedEngine> {
  if (options.host !== undefined) {
    return { context: DEFAULT_CONTEXT, host: options.host };
  }
  if (options.context !== undefined) {
    return {
      context: options.context,
      host:
        options.context === DEFAULT_CONTEXT
          ? platformHost()
          : await storedHost(options.context),
    };
  }
  const context = await currentContext();
  return { context, host: await hostOfContext(context) };
}

/** Each context of the context store, and the default context. */
export async function listContexts(): Promise<DockerContext[]> {
  const current = await currentContext();
  const stored = await storedContexts();
  return [
    { name: DEFAULT_CONTEXT, host: defaultHost() },
    ...stored.toSorted((left, right) => left.name.localeCompare(right.name)),
  ].map(({ name, host }) => ({ name, host, current: name === current }));
}

async function storedContexts(): Promise<{ name: string; host: string }[]> {
  const ids = await readdir(metaDirectory()).catch((error: unknown) => {
    if (isMissingFile(error)) return [];
    throw error;
  });
  const contexts = await Promise.all(
    ids.map(async (id) => {
      const meta: unknown = JSON.parse(
        await readFile(join(metaDirectory(), id, 'meta.json'), 'utf8').catch(
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
