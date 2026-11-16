import type { Shape } from './shape.ts';

/** The kind of doc a candidate would be; its reason says why it waits. */
export const QUEUED_KINDS = [
  'recipe',
  'readme-section',
  'concept',
  'glossary-term',
  'context-map-row',
  'adr',
  'stale-claim',
] as const;

export interface QueuedCandidate {
  readonly kind: (typeof QUEUED_KINDS)[number];
  readonly title: string;
  readonly evidence: readonly string[];
  readonly reason: string;
}

export interface OpenItem {
  readonly title: string;
  readonly target: string;
}

export interface BlockedItem {
  readonly title: string;
  readonly target: string;
  readonly reason: string;
}

/** The items a report and the ledger share, read by the same rules. */
export class Items {
  readonly #shape: Shape;

  constructor(shape: Shape) {
    this.#shape = shape;
  }

  queued(value: unknown, path: string): QueuedCandidate[] {
    return this.#shape.list(value, path, (each, at) => {
      const item = this.#shape.object(each, at, [
        'kind',
        'title',
        'evidence',
        'reason',
      ]);
      return {
        kind: this.#shape.oneOf(item.get('kind'), `${at}.kind`, QUEUED_KINDS),
        title: this.#shape.text(item.get('title'), `${at}.title`),
        evidence: this.#shape.list(
          item.get('evidence'),
          `${at}.evidence`,
          (ref, p) => this.#shape.text(ref, p),
        ),
        reason: this.#shape.text(item.get('reason'), `${at}.reason`),
      };
    });
  }

  open(value: unknown, path: string): OpenItem[] {
    return this.#shape.list(value, path, (each, at) => {
      const item = this.#shape.object(each, at, ['title', 'target']);
      return {
        title: this.#shape.text(item.get('title'), `${at}.title`),
        target: this.#shape.text(item.get('target'), `${at}.target`),
      };
    });
  }

  blocked(value: unknown, path: string): BlockedItem[] {
    return this.#shape.list(value, path, (each, at) => {
      const item = this.#shape.object(each, at, ['title', 'target', 'reason']);
      return {
        title: this.#shape.text(item.get('title'), `${at}.title`),
        target: this.#shape.text(item.get('target'), `${at}.target`),
        reason: this.#shape.text(item.get('reason'), `${at}.reason`),
      };
    });
  }
}
