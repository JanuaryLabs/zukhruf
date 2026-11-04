import type { Leaf, RecordVisitor } from '../record-visitor.ts';

const shown = (value: unknown) =>
  value === undefined ? 'nothing' : JSON.stringify(value);

// Each leaf whose two values do not agree, named by its path.
export class Differences implements RecordVisitor {
  readonly #lines: string[] = [];

  leaf(leaf: Leaf): void {
    if (!leaf.agrees)
      this.#lines.push(
        `${leaf.path}: expected ${shown(leaf.expected)}, stated ${shown(leaf.stated)}`,
      );
  }

  get none(): boolean {
    return this.#lines.length === 0;
  }

  lines(): readonly string[] {
    return this.#lines;
  }
}
