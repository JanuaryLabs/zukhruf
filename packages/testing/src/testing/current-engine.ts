import { Docker } from '@zukhruf/docker';

import { servedConnection } from '../docker/run-records.ts';

/**
 * The engine that this process's context selects, as its run names it: in a
 * run on an ssh:// engine, that endpoint, not the run's local docker.sock.
 */
const host =
  (await Docker.contexts({ environment: process.env })).find(
    (context) => context.current,
  )?.host ?? '';
export const engine = (await servedConnection(host))?.endpoint ?? host;

export const proxyless = engine.startsWith('unix://')
  ? false
  : `the engine proxy forwards to a local unix:// engine only, not ${engine}`;
