import {
  type Cell,
  type Comparer,
  type Primitive,
  type RunLog,
  type Section,
  Table,
} from '../../index.ts';
import { BagOfWords } from '../comparison/bag-of-words.ts';
import type { Comparison } from '../comparison/comparison.ts';
import { Field } from '../comparison/field.ts';
import type { Item, Pair } from '../comparison/item-pairs.ts';
import type { LeafPair } from '../comparison/leaf-pair.ts';
import type { Path } from '../comparison/path.ts';
import type { LeafOptions } from '../scorers/leaf-matches.ts';
import type { Case } from '../scoring/case.ts';

// The five classes of a leaf and of an item of an array (structured ADR 0014),
// the words of SemEval 2013 task 9.1 as nervaluate reports them.
type ErrorClass = 'correct' | 'partial' | 'incorrect' | 'missed' | 'spurious';

const classes = [
  'correct',
  'partial',
  'incorrect',
  'missed',
  'spurious',
] as const satisfies readonly ErrorClass[];

const errorClasses = [
  'partial',
  'incorrect',
  'missed',
  'spurious',
] as const satisfies readonly ErrorClass[];

type Row = {
  readonly label: string;
  readonly counts: Record<ErrorClass, number>;
};

// How often each field of the answers of a run has each class, and how often
// each array has each class of item (structured ADR 0014). Each answer, of
// each epoch, is compared again with its case by the comparer of the eval,
// as the scorers compare it; a failed answer is null (ADR 0005), so each of
// its expected leaves and items is missed. A row is a field, such as
// $.offers[*].kind, or the items of an array, such as $.offers items, in the
// order the walks first reach them, the array before the fields of its items.
// The claim names the row with the most errors.
export class FieldErrors<C extends Case> implements Section {
  readonly id = 'field-errors';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    log: RunLog<unknown, C>,
    // The leaf options of the eval's scorers, such as nullIsMissing, so that a
    // leaf is classed as the scores count it (structured ADR 0014, point 1).
    {
      comparer,
      nullIsMissing = false,
    }: { readonly comparer: Comparer<C, Comparison> } & LeafOptions,
  ) {
    if (log.samples.length === 0)
      throw new RangeError('A FieldErrors section needs a sample to compare');
    const rows = new Map<string, Row>();
    const count = (label: string, errorClass: ErrorClass, times = 1) => {
      let row = rows.get(label);
      if (row === undefined) {
        row = {
          label,
          counts: {
            correct: 0,
            partial: 0,
            incorrect: 0,
            missed: 0,
            spurious: 0,
          },
        };
        rows.set(label, row);
      }
      row.counts[errorClass] += times;
    };
    for (const sample of log.samples) {
      const comparison = comparer.compare(sample.answer, sample.case);
      const leaves = comparison.leaves({ nullIsMissing });
      const allItems = comparison.arrays();
      const arrays = new Map(allItems.map((items) => [items.field.id, items]));
      const counted = new Set<string>();
      const countArray = (field: Field) => {
        const items = arrays.get(field.id);
        if (items === undefined || counted.has(field.id)) return;
        counted.add(field.id);
        const label = `${field.toString()} items`;
        for (const pair of items.pairs)
          count(label, FieldErrors.#itemClass(pair, leaves));
        count(label, 'missed', items.unpairedExpected.length);
        count(label, 'spurious', items.unpairedStated.length);
      };
      for (const pair of leaves) {
        const { field } = (pair.expected ?? pair.stated).path;
        for (const [index, step] of field.steps.entries())
          if (step === Field.item)
            countArray(new Field(field.steps.slice(0, index)));
        count(field.toString(), FieldErrors.#leafClass(pair));
      }
      for (const { field } of allItems) countArray(field);
    }
    const table = [...rows.values()];
    this.claim = FieldErrors.#claim(table);
    this.primitives = [
      new Table(
        ['field', ...classes],
        table.map(({ label, counts }) => [
          FieldErrors.#cell(label),
          ...classes.map((errorClass) =>
            FieldErrors.#cell(String(counts[errorClass])),
          ),
        ]),
      ),
    ];
  }

  // Correct when the comparator of the field agrees; partial when the two
  // sides disagree and share a word as TokenF1 reads words (BagOfWords, SQuAD's
  // normalize_answer); incorrect when they share none. FieldDiff has a copy
  // (docs/copied-code.md).
  static #leafClass(pair: LeafPair): ErrorClass {
    if (pair.expected === undefined) return 'spurious';
    if (pair.stated === undefined) return 'missed';
    if (pair.agrees) return 'correct';
    const shared = BagOfWords.of(pair.expected.value).shared(
      BagOfWords.of(pair.stated.value),
    );
    return shared.hits > 0 ? 'partial' : 'incorrect';
  }

  // The class of a paired item by the classes of the leaves under it, on
  // either side: correct when each is correct (an item with no leaf too),
  // incorrect when none is, else partial.
  static #itemClass(pair: Pair, leaves: readonly LeafPair[]): ErrorClass {
    const under = leaves.filter(
      (leaf) =>
        (leaf.expected !== undefined &&
          FieldErrors.#isUnder(leaf.expected.path, pair.expected)) ||
        (leaf.stated !== undefined &&
          FieldErrors.#isUnder(leaf.stated.path, pair.stated)),
    );
    const correct = under.filter(
      (leaf) => FieldErrors.#leafClass(leaf) === 'correct',
    ).length;
    if (correct === under.length) return 'correct';
    return correct === 0 ? 'incorrect' : 'partial';
  }

  static #isUnder(path: Path, item: Item): boolean {
    return item.path.steps.every((step, index) => path.steps[index] === step);
  }

  static #claim(rows: readonly Row[]): string {
    const errors = ({ counts }: Row) =>
      errorClasses.reduce((sum, errorClass) => sum + counts[errorClass], 0);
    const worst = rows.reduce<Row | undefined>(
      (most, row) =>
        most === undefined || errors(row) > errors(most) ? row : most,
      undefined,
    );
    if (worst === undefined || errors(worst) === 0)
      return 'Every field of every answer is right';
    const total = classes.reduce(
      (sum, errorClass) => sum + worst.counts[errorClass],
      0,
    );
    const parts = errorClasses
      .filter((errorClass) => worst.counts[errorClass] > 0)
      .map((errorClass) => `${worst.counts[errorClass]} ${errorClass}`);
    return `${worst.label} is wrong most often: ${errors(worst)} of ${total} (${parts.join(', ')})`;
  }

  static #cell(text: string): Cell {
    return { text, tone: 'neutral' };
  }
}
