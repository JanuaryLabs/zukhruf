import type { Leaf, RecordVisitor } from '../record-visitor.ts';

// Each leaf whose two values do not agree, named by its path.
export class Differences implements RecordVisitor {
  readonly #lines: string[] = [];

  leaf(leaf: Leaf): void {
    if (!leaf.agrees)
      this.#lines.push(
        `${leaf.path}: expected ${Differences.#shown(leaf.expected)}, stated ${Differences.#shown(leaf.stated)}`,
      );
  }

  get none(): boolean {
    return this.#lines.length === 0;
  }

  lines(): readonly string[] {
    return this.#lines;
  }

  static #shown(value: unknown): string {
    return value === undefined ? 'nothing' : JSON.stringify(value);
  }
}
