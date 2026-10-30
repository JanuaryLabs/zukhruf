// The vectors gave no similarity for an article of the stream: the article
// is not stored, or it is stored with another publish date.
export class MissingVectorError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(
      `The vectors have no article ${id} with the publish date of the stream. Store the article with this publish date first.`,
    );
    this.name = 'MissingVectorError';
    this.id = id;
  }
}

// Scores were asked about an article that is not in their stream.
export class UnknownArticleError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`The article ${id} is not in the stream of these scores.`);
    this.name = 'UnknownArticleError';
    this.id = id;
  }
}
