import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes a Docker configuration directory as the Docker CLI writes it:
 * config.json with currentContext, and contexts/meta/<sha256 of the name>/meta.json
 * for each context.
 */
export async function writeContextStore(
  directory: string,
  store: { currentContext?: string; contexts: Record<string, string> },
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify(
      store.currentContext === undefined
        ? {}
        : { currentContext: store.currentContext },
    ),
  );
  for (const [name, host] of Object.entries(store.contexts)) {
    const meta = join(
      directory,
      'contexts',
      'meta',
      createHash('sha256').update(name).digest('hex'),
    );
    await mkdir(meta, { recursive: true });
    await writeFile(
      join(meta, 'meta.json'),
      JSON.stringify({
        Name: name,
        Metadata: {},
        Endpoints: { docker: { Host: host, SkipTLSVerify: false } },
      }),
    );
  }
}
