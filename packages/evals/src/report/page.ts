import type { Section } from '../index.ts';

// A title and its sections, in the order that the host composes them
// (Composite, report ADR 0001). A renderer draws it in one format.
export class Page {
  readonly title: string;
  readonly sections: readonly Section[];

  constructor(title: string, sections: readonly Section[]) {
    this.title = title;
    this.sections = sections;
  }
}
