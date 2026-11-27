import { hash } from 'node:crypto';

/**
 * The files of a home directory whose `.docker` configuration directory is as
 * the Docker CLI writes it: config.json with currentContext, and
 * contexts/meta/<sha256 of the name>/meta.json for each context. The record is
 * the `files` of `TemporaryFiles` of `@zukhruf/fs`.
 */
export function contextStoreFiles(store: {
  currentContext?: string;
  contexts: Record<string, string>;
}): Record<string, string> {
  return {
    '.docker/config.json': JSON.stringify(
      store.currentContext === undefined
        ? {}
        : { currentContext: store.currentContext },
    ),
    ...Object.fromEntries(
      Object.entries(store.contexts).map(([name, host]) => [
        `.docker/contexts/meta/${hash('sha256', name)}/meta.json`,
        JSON.stringify({
          Name: name,
          Metadata: {},
          Endpoints: { docker: { Host: host, SkipTLSVerify: false } },
        }),
      ]),
    ),
  };
}
