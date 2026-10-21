import { timebox } from '../async/timebox.ts';
import type { DockerFixtures } from '../docker/fixtures.ts';
import type { ServiceContainer } from '../docker/service-container.ts';
import { succeeded } from './succeeded.ts';

/** Each start owns a dedicated ClickHouse server and its disposable container. */
export class ClickHouse {
  readonly #docker: DockerFixtures;
  readonly #image: string;

  constructor({ docker, image }: { docker: DockerFixtures; image: string }) {
    this.#docker = docker;
    this.#image = image;
  }

  start(): Promise<ServiceContainer> {
    return this.#docker.serve({
      image: this.#image,
      internalPort: 8123,
      memory: '2g',
      env: { CLICKHOUSE_SKIP_USER_SETUP: '1' },
      healthy: (service) =>
        timebox(
          () =>
            succeeded(service, ['clickhouse-client', '--query', 'SELECT 1']),
          { maxRetryTime: 60_000 },
        ),
    });
  }
}
