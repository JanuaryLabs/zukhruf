import { writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// The types of question whose temperature decide reads. IndexApply reads the
// temperature of Choice (venn/server.py:804), and NearestReference divides
// its margin by its own (venn/server.py:974-975).
export type CalibrationKind = 'Choice' | 'Score' | 'Noul' | 'NearestReference';

// The temperatures that registerCalibration fits, by family and type of
// question, in the file at registryPath, as Venn's DecisionService keeps
// them (venn/server.py:91-93, 465-483): an object of "<family>/<type>"
// keys, in the order of their first registration, written again after each
// change.
export class Calibrations {
  readonly #path: string;
  #temperatures: ReadonlyMap<string, number>;

  private constructor(path: string, temperatures: ReadonlyMap<string, number>) {
    this.#path = path;
    this.#temperatures = temperatures;
  }

  // The temperatures of the file at `path`, or none when there is no file
  // (venn/server.py:91-93).
  static async open(path: string): Promise<Calibrations> {
    await mkdir(dirname(path), { recursive: true });
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (Error.isError(error) && 'code' in error && error.code === 'ENOENT')
        return new Calibrations(path, new Map());
      throw error;
    }
    return new Calibrations(path, Calibrations.#parse(path, text));
  }

  // Decide divides logits by each temperature, so a file that holds anything
  // but positive finite numbers is refused at load, before any answer.
  static #parse(path: string, text: string): Map<string, number> {
    const message = `${path} is not an object of positive temperatures by family and type.`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new TypeError(message, { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new TypeError(message);
    const temperatures = new Map<string, number>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw new TypeError(message);
      temperatures.set(key, value);
    }
    return temperatures;
  }

  static #key(family: string, kind: CalibrationKind): string {
    return `${family}/${kind}`;
  }

  temperature(family: string, kind: CalibrationKind): number | undefined {
    return this.#temperatures.get(Calibrations.#key(family, kind));
  }

  set(family: string, kind: CalibrationKind, temperature: number): void {
    this.#change(
      new Map(this.#temperatures).set(
        Calibrations.#key(family, kind),
        temperature,
      ),
    );
  }

  delete(family: string, kind: CalibrationKind): void {
    const temperatures = new Map(this.#temperatures);
    temperatures.delete(Calibrations.#key(family, kind));
    this.#change(temperatures);
  }

  // Writes the temperatures before decide reads them, so a failed write
  // leaves decide with what the file holds. Venn changes its map first
  // (venn/server.py:476-477). The text is what Venn writes,
  // json.dumps(calibrations, indent=2) and a new line, in place. The write is
  // synchronous, so two changes never write at once.
  #change(temperatures: ReadonlyMap<string, number>): void {
    writeFileSync(
      this.#path,
      `${JSON.stringify(Object.fromEntries(temperatures), null, 2)}\n`,
    );
    this.#temperatures = temperatures;
  }
}
