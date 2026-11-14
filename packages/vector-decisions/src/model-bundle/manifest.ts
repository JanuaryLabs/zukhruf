import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InvalidModelArtifactError } from './invalid-model-artifact-error.ts';

const FILE = 'manifest.json';

// The manifest.json of a model directory: the SHA-256 of each file, by name,
// as Venn's publish script writes it ({ "sha256": { <file>: <digest> } }).
export class Manifest {
  readonly digests: ReadonlyMap<string, string>;

  private constructor(digests: ReadonlyMap<string, string>) {
    this.digests = digests;
  }

  static async read(directory: string): Promise<Manifest> {
    const text = await readFile(join(directory, FILE), 'utf8');
    return new Manifest(new Map(Object.entries(Manifest.#sha256(text))));
  }

  static #sha256(text: string): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw Manifest.#invalid();
    }
    const sha256: unknown =
      typeof parsed === 'object' && parsed !== null && 'sha256' in parsed
        ? parsed.sha256
        : undefined;
    if (!Manifest.#isDigests(sha256)) throw Manifest.#invalid();
    return sha256;
  }

  static #isDigests(value: unknown): value is Record<string, string> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((digest) => typeof digest === 'string')
    );
  }

  static #invalid(): InvalidModelArtifactError {
    return new InvalidModelArtifactError(
      FILE,
      'is not { sha256: { <file>: <digest> } }',
    );
  }
}
