import { ConflictingAnswerError } from './errors.ts';
import type { Keyword } from './keyword.ts';

export type ProfileFields = {
  // The name that the reader gave the interest.
  readonly name: string;
  // One sentence that says what the reader wants to read.
  readonly description: string;
  readonly keywords?: readonly Keyword[];
  // The ids of the articles that the reader answered yes and no for.
  readonly relevant: readonly string[];
  readonly notRelevant: readonly string[];
};

// A reader's interest: a name, a description, optional keywords and the
// answers that taught it. It is a value: it does no I/O, and a correction
// gives a new profile (docs/adr/0001). A scorer scores a stream for it
// (docs/adr/0005).
export class Profile {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly Keyword[];
  readonly relevant: readonly string[];
  readonly notRelevant: readonly string[];

  constructor(fields: ProfileFields) {
    const relevant = new Set(fields.relevant);
    const conflict = fields.notRelevant.find((id) => relevant.has(id));
    if (conflict !== undefined) throw new ConflictingAnswerError(conflict);
    this.name = fields.name;
    this.description = fields.description;
    this.keywords = Object.freeze([...(fields.keywords ?? [])]);
    this.relevant = Object.freeze([...fields.relevant]);
    this.notRelevant = Object.freeze([...fields.notRelevant]);
  }

  // A copy of the profile with the given fields changed.
  with(changes: Partial<ProfileFields>): Profile {
    return new Profile({
      name: this.name,
      description: this.description,
      keywords: this.keywords,
      relevant: this.relevant,
      notRelevant: this.notRelevant,
      ...changes,
    });
  }
}
