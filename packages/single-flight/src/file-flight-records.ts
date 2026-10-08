import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Finished,
  type FlightRecords,
  type LatestFlight,
  type Outcome,
  isOutcome,
  isRecord,
} from './flight-records.ts';
import { patiently } from './patiently.ts';

type Kept = Exclude<Outcome, { status: 'missing' }>;

interface Entry {
  readonly id: string;
  readonly outcome: Kept;
  readonly endedAt?: number;
}

const isEntry = (value: unknown): value is Entry =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  isOutcome(value['outcome']) &&
  value['outcome'].status !== 'missing' &&
  (value['endedAt'] === undefined || typeof value['endedAt'] === 'number');

const isFlightFile = (
  value: unknown,
): value is { readonly flights: readonly Entry[] } =>
  isRecord(value) &&
  Array.isArray(value['flights']) &&
  value['flights'].every(isEntry);

export interface FileFlightRecordsOptions {
  /**
   * Milliseconds that the outcome of a flight stays readable after the flight
   * ended. A joiner reads it once per poll interval, so keep it at least 20
   * times the `pollInterval` of every joiner. Defaults to 60 000.
   */
  keepFor?: number;
}

/**
 * Keeps the flight records of each key in one JSON file in `directory`. Give
 * the records a directory of their own, never the lock directory of a mutex.
 */
export class FileFlightRecords implements FlightRecords {
  readonly #directory: string;
  readonly #keepFor: number;

  constructor(
    directory: string,
    { keepFor = 60_000 }: FileFlightRecordsOptions = {},
  ) {
    if (!(keepFor >= 0) || !Number.isFinite(keepFor)) {
      throw new RangeError(
        `keepFor must be a finite number of milliseconds >= 0, got ${keepFor}.`,
      );
    }
    this.#directory = directory;
    this.#keepFor = keepFor;
  }

  async begin(key: string): Promise<string> {
    const id = randomUUID();
    const endedAt = Date.now();
    const flights = (await this.#read(key)).map((flight): Entry =>
      flight.outcome.status === 'running'
        ? {
            id: flight.id,
            outcome: { status: 'interrupted', successor: id },
            endedAt,
          }
        : flight,
    );
    await this.#write(key, [
      ...flights,
      { id, outcome: { status: 'running' } },
    ]);
    return id;
  }

  async finish(key: string, id: string, outcome: Finished): Promise<void> {
    const flights = await this.#read(key);
    const running = flights.some(
      (flight) => flight.id === id && flight.outcome.status === 'running',
    );
    if (!running) return;
    const endedAt = Date.now();
    await this.#write(
      key,
      flights.map((flight) =>
        flight.id === id ? { id, outcome, endedAt } : flight,
      ),
    );
  }

  async latest(key: string): Promise<LatestFlight | undefined> {
    const last = (await this.#read(key)).at(-1);
    return last && { id: last.id, status: last.outcome.status };
  }

  async outcome(key: string, id: string): Promise<Outcome> {
    const flight = (await this.#read(key)).find((flight) => flight.id === id);
    return flight?.outcome ?? { status: 'missing' };
  }

  /**
   * A key can hold characters that no file name can, such as `:` on Windows
   * or `/`, and two keys can differ only by case, which a case-insensitive
   * file system ignores. The hex digest has none of these problems. It digests
   * the UTF-16 code units: UTF-8 would turn every lone surrogate into U+FFFD
   * and give such keys one record.
   */
  #pathOf(key: string): string {
    const name = createHash('sha256').update(key, 'utf16le').digest('hex');
    return join(this.#directory, `${name}.json`);
  }

  /**
   * A finished flight leaves once it ended `keepFor` ago. The flight that
   * began last always stays, so `latest` still knows it.
   */
  #kept(flights: readonly Entry[], now: number): readonly Entry[] {
    return flights.filter(
      (flight, index) =>
        index === flights.length - 1 ||
        flight.endedAt === undefined ||
        now - flight.endedAt < this.#keepFor,
    );
  }

  async #read(key: string): Promise<readonly Entry[]> {
    const path = this.#pathOf(key);
    let text: string;
    try {
      text = await patiently(() => readFile(path, 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
    const content = parseJson(text, path);
    if (!isFlightFile(content)) throw notAFlightFile(path);
    return content.flights;
  }

  /** Replaces the file in one step, so a joiner reads the old records or the new ones, never a part. */
  async #write(key: string, flights: readonly Entry[]) {
    const path = this.#pathOf(key);
    const draft = `${path}.${randomUUID()}.tmp`;
    const kept = this.#kept(flights, Date.now());
    await mkdir(this.#directory, { recursive: true });
    try {
      await writeFile(draft, JSON.stringify({ key, flights: kept }));
      await patiently(() => rename(draft, path));
    } catch (error) {
      await rm(draft, { force: true });
      throw error;
    }
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw notAFlightFile(path, { cause: error });
  }
}

const notAFlightFile = (path: string, options?: ErrorOptions) =>
  new Error(
    `${JSON.stringify(path)} is not a file of flight records. Give the records a directory of their own.`,
    options,
  );

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
