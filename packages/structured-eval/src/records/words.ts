import { normalized } from './normalized.ts';

// The words of a text, each with how often it occurs. Two texts share a word
// as often as both have it, as SQuAD scores an answer.
export class Words {
  readonly #counts: ReadonlyMap<string, number>;
  readonly #size: number;

  private constructor(words: readonly string[]) {
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    this.#counts = counts;
    this.#size = words.length;
  }

  static of(text: string): Words {
    return new Words(
      normalized(text)
        .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(' ')
        .filter((word) => word !== ''),
    );
  }

  f1(other: Words): number {
    let shared = 0;
    for (const [word, count] of this.#counts)
      shared += Math.min(count, other.#counts.get(word) ?? 0);
    return shared === 0 ? 0 : (2 * shared) / (this.#size + other.#size);
  }
}
