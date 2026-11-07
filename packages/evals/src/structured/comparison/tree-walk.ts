import type { JsonData } from '@zukhruf/python';

import type { Comparer } from '../../scoring/comparer.ts';
import type { Case } from '../scoring/case.ts';
import type { Agreement } from './alignment.ts';
import { ComparisonSpec } from './comparison-spec.ts';
import { Comparison } from './comparison.ts';
import { Field, type FieldStep } from './field.ts';
import type { ItemPairs } from './item-pairs.ts';
import { statedData } from './json-value.ts';
import type { Leaf, LeafPair } from './leaf-pair.ts';
import { Path, type Step } from './path.ts';

// What the walk of one stated value and one expected value finds.
type Found = {
  readonly leaves: LeafPair[];
  readonly statedPaths: Path[];
  readonly arrays: ItemPairs[];
};

// Walks a stated value and the expected value of its case side by side, as
// the spec says, and gives their Comparison. Objects line up by key, and the
// items of an array pair by the alignment of its field. Every other value is
// a leaf, null too; the comparator of its field says if the two sides agree.
// A value at the root is no leaf, so a stated value that is not an object or
// an array has no leaves. Where the two sides differ in kind, each side is
// walked alone. An excluded field adds no leaf pair and no item pairs, but its
// stated values still have their fields. A stated text is read as
// json.loads reads it; a stated JsonValue stays as it is.
export class TreeWalk implements Comparer<Case, Comparison> {
  readonly #spec: ComparisonSpec;

  constructor(spec = new ComparisonSpec()) {
    this.#spec = spec;
  }

  compare(stated: unknown, testCase: Case): Comparison {
    const data = statedData(stated);
    const found = TreeWalk.#nothingFound();
    this.#walk(
      data,
      testCase.expected,
      new Path([]),
      new Path([]),
      new Field([]),
      found,
    );
    return new Comparison(
      testCase,
      data,
      found.leaves,
      found.statedPaths,
      found.arrays,
    );
  }

  // The expected side goes first at each step, so the expected leaves come in
  // the order of the expected value, as evaluate.py reads them.
  #walk(
    stated: JsonData | undefined,
    expected: JsonData | undefined,
    statedPath: Path,
    expectedPath: Path,
    field: Field,
    found: Found,
  ): void {
    if (this.#spec.excludes(field)) {
      TreeWalk.#statedPaths(stated, statedPath, found);
      return;
    }
    const root = field.steps.length === 0;
    if (stated !== undefined && !root) found.statedPaths.push(statedPath);
    if (stated instanceof Map && expected instanceof Map)
      this.#object(stated, expected, statedPath, expectedPath, field, found);
    else if (Array.isArray(stated) && Array.isArray(expected))
      this.#array(stated, expected, statedPath, expectedPath, field, found);
    else this.#apart(stated, expected, statedPath, expectedPath, field, found);
    if (root) return;
    const expectedLeaf = TreeWalk.#leaf(expected, expectedPath);
    const statedLeaf = TreeWalk.#leaf(stated, statedPath);
    if (expectedLeaf !== undefined && statedLeaf !== undefined)
      found.leaves.push({
        expected: expectedLeaf,
        stated: statedLeaf,
        agrees: this.#spec
          .comparatorOf(field)
          .agrees(statedLeaf.value, expectedLeaf.value),
      });
    else if (expectedLeaf !== undefined)
      found.leaves.push({ expected: expectedLeaf });
    else if (statedLeaf !== undefined)
      found.leaves.push({ stated: statedLeaf });
  }

  #object(
    stated: Map<string, JsonData>,
    expected: Map<string, JsonData>,
    statedPath: Path,
    expectedPath: Path,
    field: Field,
    found: Found,
  ): void {
    for (const [key, value] of expected)
      this.#walk(
        stated.get(key),
        value,
        statedPath.child(key),
        expectedPath.child(key),
        field.child(key),
        found,
      );
    for (const [key, value] of stated)
      if (!expected.has(key))
        this.#walk(
          value,
          undefined,
          statedPath.child(key),
          expectedPath.child(key),
          field.child(key),
          found,
        );
  }

  // The expected items in their order, each with the stated item that the
  // alignment pairs with it, then the stated items without a pair.
  #array(
    stated: readonly JsonData[],
    expected: readonly JsonData[],
    statedPath: Path,
    expectedPath: Path,
    field: Field,
    found: Found,
  ): void {
    const item = field.child(Field.item);
    const agreement: Agreement = {
      count: (statedItem, expectedItem) =>
        this.#agreeingLeaves(statedItem, expectedItem, item),
    };
    const pairs = this.#spec
      .alignmentOf(field)
      .pairs(stated, expected, agreement);
    found.arrays.push({
      field,
      expected: expected.length,
      stated: stated.length,
      paired: pairs.length,
    });
    const statedOf = new Map(
      pairs.map(([statedIndex, expectedIndex]) => [expectedIndex, statedIndex]),
    );
    for (const [index, value] of expected.entries()) {
      const statedIndex = statedOf.get(index);
      this.#walk(
        statedIndex === undefined ? undefined : stated[statedIndex],
        value,
        statedPath.child(statedIndex ?? index),
        expectedPath.child(index),
        item,
        found,
      );
    }
    const paired = new Set(statedOf.values());
    for (const [index, value] of stated.entries())
      if (!paired.has(index))
        this.#walk(
          value,
          undefined,
          statedPath.child(index),
          expectedPath.child(index),
          item,
          found,
        );
  }

  // Two values of different kinds: each side is walked alone. An array on
  // one side has its items, and the other side has none.
  #apart(
    stated: JsonData | undefined,
    expected: JsonData | undefined,
    statedPath: Path,
    expectedPath: Path,
    field: Field,
    found: Found,
  ): void {
    if (Array.isArray(stated) || Array.isArray(expected))
      found.arrays.push({
        field,
        expected: Array.isArray(expected) ? expected.length : 0,
        stated: Array.isArray(stated) ? stated.length : 0,
        paired: 0,
      });
    for (const [step, fieldStep, value] of TreeWalk.#children(expected))
      this.#walk(
        undefined,
        value,
        statedPath.child(step),
        expectedPath.child(step),
        field.child(fieldStep),
        found,
      );
    for (const [step, fieldStep, value] of TreeWalk.#children(stated))
      this.#walk(
        value,
        undefined,
        statedPath.child(step),
        expectedPath.child(step),
        field.child(fieldStep),
        found,
      );
  }

  // The leaf pairs of a stated item and an expected item that agree, by the
  // rules of the spec under the field of the items.
  #agreeingLeaves(stated: JsonData, expected: JsonData, item: Field): number {
    const found = TreeWalk.#nothingFound();
    this.#walk(stated, expected, new Path([]), new Path([]), item, found);
    return found.leaves.filter((pair) => pair.agrees === true).length;
  }

  // The paths of a stated value and of each value under it.
  static #statedPaths(
    stated: JsonData | undefined,
    path: Path,
    found: Found,
  ): void {
    if (stated === undefined) return;
    if (path.steps.length > 0) found.statedPaths.push(path);
    for (const [step, , value] of TreeWalk.#children(stated))
      TreeWalk.#statedPaths(value, path.child(step), found);
  }

  static *#children(
    value: JsonData | undefined,
  ): Generator<readonly [Step, FieldStep, JsonData]> {
    if (value instanceof Map)
      for (const [key, child] of value) yield [key, key, child];
    else if (Array.isArray(value))
      for (const [index, child] of value.entries())
        yield [index, Field.item, child];
  }

  static #leaf(value: JsonData | undefined, path: Path): Leaf | undefined {
    if (value === undefined || value instanceof Map || Array.isArray(value))
      return undefined;
    return { path, value };
  }

  static #nothingFound(): Found {
    return { leaves: [], statedPaths: [], arrays: [] };
  }
}
