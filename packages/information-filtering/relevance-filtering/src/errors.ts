// One article is both a relevant and a not-relevant answer of a profile.
export class ConflictingAnswerError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(
      `The article ${id} is both a relevant and a not-relevant answer. Give it one answer.`,
    );
    this.name = 'ConflictingAnswerError';
    this.id = id;
  }
}

// The profile has no relevant answer that the filter can learn from and no
// keyword, so it has nothing to decide with.
export class NoEvidenceError extends Error {
  constructor(profile: string) {
    super(
      `The profile ${profile} has no keyword and no relevant answer that the filter can learn from. Teach it a relevant article, or give it a keyword.`,
    );
    this.name = 'NoEvidenceError';
  }
}

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

// The filter was asked about an article that is not in its stream.
export class UnknownArticleError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`The article ${id} is not in the stream of this filter.`);
    this.name = 'UnknownArticleError';
    this.id = id;
  }
}
