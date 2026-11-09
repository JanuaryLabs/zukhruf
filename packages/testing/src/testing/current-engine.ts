import { Docker } from '@zukhruf/docker';

/** The host of the engine that this process's context selects. */
export const engine =
  (await Docker.contexts({ environment: process.env })).find(
    (context) => context.current,
  )?.host ?? '';

export const proxyless = engine.startsWith('unix://')
  ? false
  : `the engine proxy forwards to a local unix:// engine only, not ${engine}`;
