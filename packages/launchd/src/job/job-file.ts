import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { type PlistValue, build } from 'plist';

import type { Clock } from '@zukhruf/async';
import { atomicWrite, isErrno } from '@zukhruf/fs';

import { PermissionDeniedError } from '../errors.ts';
import type { Job } from './job.ts';

const EXTENSION = '.plist';

/** The job file of one label: `<folder>/<label>.plist`. */
export class JobFile {
  readonly label: string;
  readonly path: string;
  readonly #folder: string;

  /** Throws a RangeError for a label that is not one file name, so the file stays in the folder. */
  constructor(folder: string, label: string) {
    if (!JobFile.#isFileName(label)) {
      throw new RangeError(
        `A label names its job file, so it must be one file name: ${JSON.stringify(label)}`,
      );
    }
    this.label = label;
    this.path = join(folder, `${label}${EXTENSION}`);
    this.#folder = folder;
  }

  /** The labels of the job files in the folder, sorted. No folder: none. */
  static async labels(folder: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith(EXTENSION))
      .map((name) => name.slice(0, -EXTENSION.length))
      .filter((label) => JobFile.#isFileName(label))
      .toSorted();
  }

  /** The bytes of the job file of a job, with the keys of each dictionary sorted. */
  static render(job: Job): string {
    return build(JobFile.#sorted(job));
  }

  /** Whether the file holds these bytes. No file: false. */
  async holds(content: string): Promise<boolean> {
    try {
      return (await readFile(this.path, 'utf8')) === content;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
  }

  /** Makes the folder, and replaces the file in one step, with mode 0644. */
  async write(content: string, clock: Clock): Promise<void> {
    try {
      await mkdir(this.#folder, { recursive: true });
      await atomicWrite(this.path, content, { clock, mode: 0o644 });
    } catch (error) {
      throw JobFile.#denied(error);
    }
  }

  /** Removes the file. No file: nothing to do. */
  async remove(): Promise<void> {
    try {
      await rm(this.path, { force: true });
    } catch (error) {
      throw JobFile.#denied(error);
    }
  }

  static #denied(error: unknown): unknown {
    return Error.isError(error) &&
      (isErrno(error, 'EACCES') || isErrno(error, 'EPERM'))
      ? new PermissionDeniedError(error)
      : error;
  }

  static #isFileName(label: string): boolean {
    return (
      label !== '' &&
      label !== '.' &&
      label !== '..' &&
      !label.includes('/') &&
      !label.includes('\0')
    );
  }

  // An array keeps its order: it has a meaning in ProgramArguments. An
  // undefined value becomes null, which plist renders as no key (ADR 0008).
  static #sorted(value: unknown): PlistValue {
    if (Array.isArray(value)) return value.map((item) => JobFile.#sorted(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .map((key) => [key, JobFile.#sorted(Reflect.get(value, key))]),
      );
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    return null;
  }
}
