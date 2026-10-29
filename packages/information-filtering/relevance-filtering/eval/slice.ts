import type { Collection } from '@zukhruf/embeddings';

import type { Keyword } from '../src/index.ts';
import {
  type Article,
  type EvalSet,
  type Label,
  readSet,
} from './answer-key.ts';
import { type Text, collectionOf, keywordText, textsOf } from './cache.ts';

// A labelled set with its texts and its vectors, ready for a run.
export class LoadedSet implements Disposable {
  readonly set: EvalSet;
  readonly texts: ReadonlyMap<string, Text>;
  readonly collection: Collection;
  readonly #dispose: () => void;

  constructor(name: string) {
    this.set = readSet(name);
    this.texts = textsOf(name);
    const { database, collection } = collectionOf(name);
    this.collection = collection;
    this.#dispose = () => database.close();
  }

  get articles(): readonly Article[] {
    return this.set.articles;
  }

  // The text that the keywords are matched in.
  textOf = (id: string): string => {
    const text = this.texts.get(id);
    if (text === undefined)
      throw new Error(`The cache has no text of ${id}. Seed the cache.`);
    return keywordText(text);
  };

  matches(keyword: RegExp): boolean[] {
    return this.articles.map(
      ({ id }) => this.textOf(id).search(keyword) !== -1,
    );
  }

  labelsFor(profile: string): (Label | undefined)[] {
    return this.set.labels.map((labels) => labels[profile]);
  }

  // The similarity of the description to each article, in the order of the
  // articles, through the query of the collection.
  similarities(descriptionVector: readonly number[]): number[] {
    const times = this.articles.map(({ publishedAt }) => publishedAt.getTime());
    const similarities = new Map(
      this.collection
        .query(descriptionVector, {
          from: new Date(Math.min(...times)),
          to: new Date(Math.max(...times)),
        })
        .map(({ id, similarity }) => [id, similarity]),
    );
    return this.articles.map(({ id }) => similarities.get(id) ?? Number.NaN);
  }

  [Symbol.dispose](): void {
    this.#dispose();
  }
}
