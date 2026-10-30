// The reader's answer for one article that the reader saw.
export type Answer = {
  // True for yes (relevant), false for no.
  readonly relevant: boolean;
  // The text of the article, which the keywords are matched in.
  readonly text: string;
};

// A taught article: its id and the text of the article.
export type Taught = { readonly id: string; readonly text: string };

// The answers that a similarity scorer learns from: at least one yes, and one
// answer for each article (docs/adr/0005).
export class TaughtAnswers {
  readonly relevant: readonly [Taught, ...Taught[]];
  readonly notRelevant: readonly Taught[];

  private constructor(
    relevant: readonly [Taught, ...Taught[]],
    notRelevant: readonly Taught[],
  ) {
    this.relevant = relevant;
    this.notRelevant = notRelevant;
  }

  // The answers by article id, in the order of the map. Undefined when no
  // answer is a yes: then the reader has taught nothing to learn from.
  static parse(
    answers: ReadonlyMap<string, Answer>,
  ): TaughtAnswers | undefined {
    const taught = [...answers].map(([id, { relevant, text }]) => ({
      relevant,
      article: { id, text },
    }));
    const [first, ...rest] = taught
      .filter(({ relevant }) => relevant)
      .map(({ article }) => article);
    if (first === undefined) return undefined;
    return new TaughtAnswers(
      [first, ...rest],
      taught.filter(({ relevant }) => !relevant).map(({ article }) => article),
    );
  }
}
