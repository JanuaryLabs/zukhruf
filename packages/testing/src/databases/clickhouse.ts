import { timebox } from '../async/timebox.ts';
import type { ServiceContainer } from '../docker/container.ts';
import type { Docker } from '../docker/docker.ts';

/** Each start owns a dedicated ClickHouse server and its disposable container. */
export class ClickHouse {
  readonly #docker: Docker;
  readonly #image: string;

  constructor({ docker, image }: { docker: Docker; image: string }) {
    this.#docker = docker;
    this.#image = image;
  }

  start(): Promise<ServiceContainer> {
    return this.#docker.serve({
      image: this.#image,
      internalPort: 8123,
      memory: '2g',
      env: { CLICKHOUSE_SKIP_USER_SETUP: '1' },
      healthy: ({ exec }) =>
        timebox(() => exec(['clickhouse-client', '--query', 'SELECT 1']), {
          maxRetryTime: 60_000,
        }),
    });
  }
}
