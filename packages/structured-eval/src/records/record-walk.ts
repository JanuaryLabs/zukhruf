import type { Agreement } from './alignment.ts';
import type { RecordSpec } from './record-spec.ts';
import type { Leaf, RecordVisitor } from './record-visitor.ts';
import { hasValue, isRecord } from './values.ts';

const child = (parent: string, key: string) =>
  parent === '' ? key : `${parent}.${key}`;

class AgreeingLeaves implements RecordVisitor {
  count = 0;

  leaf(leaf: Leaf): void {
    if (leaf.agrees) this.count++;
  }
}

// Walks a stated record and an expected record side by side, as the spec
// says, and tells each visitor what it reaches: objects line up by key, the
// items of an array pair by the alignment of its field, and every other value
// is a leaf.
export class RecordWalk {
  readonly #spec: RecordSpec;

  constructor(spec: RecordSpec) {
    this.#spec = spec;
  }

  visit(
    stated: unknown,
    expected: unknown,
    visitors: readonly RecordVisitor[],
  ): void {
    this.#walk(stated, expected, '', '', visitors);
  }

  #walk(
    stated: unknown,
    expected: unknown,
    field: string,
    path: string,
    visitors: readonly RecordVisitor[],
  ) {
    if (field !== '' && this.#spec.ignores(field)) return;
    if (Array.isArray(stated) || Array.isArray(expected)) {
      this.#array(
        Array.isArray(stated) ? stated : [],
        Array.isArray(expected) ? expected : [],
        field,
        path,
        visitors,
      );
      return;
    }
    if (isRecord(stated) || isRecord(expected)) {
      const statedRecord = isRecord(stated) ? stated : {};
      const expectedRecord = isRecord(expected) ? expected : {};
      const keys = new Set([
        ...Object.keys(expectedRecord),
        ...Object.keys(statedRecord),
      ]);
      for (const key of keys)
        this.#walk(
          statedRecord[key],
          expectedRecord[key],
          child(field, key),
          child(path, key),
          visitors,
        );
      return;
    }
    if (!hasValue(expected) && !hasValue(stated)) return;
    const agrees =
      hasValue(expected) &&
      hasValue(stated) &&
      this.#spec.comparatorOf(field).agrees(stated, expected);
    const leaf = { field, path, expected, stated, agrees };
    for (const visitor of visitors) visitor.leaf?.(leaf);
  }

  #array(
    stated: readonly unknown[],
    expected: readonly unknown[],
    field: string,
    path: string,
    visitors: readonly RecordVisitor[],
  ) {
    const item = `${field}[]`;
    const agreement: Agreement = {
      count: (statedItem, expectedItem) => {
        const agreeing = new AgreeingLeaves();
        this.#walk(statedItem, expectedItem, item, '', [agreeing]);
        return agreeing.count;
      },
    };
    const pairs = this.#spec
      .alignmentOf(field)
      .pairs(stated, expected, agreement);
    const items = {
      field,
      expected: expected.length,
      stated: stated.length,
      paired: pairs.length,
    };
    for (const visitor of visitors) visitor.items?.(items);
    const statedPaired = new Set<number>();
    const expectedPaired = new Set<number>();
    for (const [statedIndex, expectedIndex] of pairs) {
      statedPaired.add(statedIndex);
      expectedPaired.add(expectedIndex);
      this.#walk(
        stated[statedIndex],
        expected[expectedIndex],
        item,
        `${path}[${expectedIndex}]`,
        visitors,
      );
    }
    for (const [index, value] of expected.entries())
      if (!expectedPaired.has(index))
        this.#walk(undefined, value, item, `${path}[${index}]`, visitors);
    for (const [index, value] of stated.entries())
      if (!statedPaired.has(index))
        this.#walk(
          value,
          undefined,
          item,
          `${path}[stated ${index}]`,
          visitors,
        );
  }
}
