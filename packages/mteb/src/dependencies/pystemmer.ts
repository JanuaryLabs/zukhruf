import EnglishStemmer from './snowball/english-stemmer.js';

// PyStemmer 3.1.0 (Stemmer.Stemmer), over the JavaScript stemmers of Snowball
// 3.1.0, the version of the libstemmer_c that PyStemmer 3.1.0 binds. Only
// the English algorithm is ported; PyStemmer's cache changes no stem and is
// not ported.
export class Stemmer {
  readonly #stemmer: EnglishStemmer;

  constructor(algorithm: string) {
    if (algorithm !== 'english')
      throw new Error(`Stemming algorithm '${algorithm}' not found`);
    this.#stemmer = new EnglishStemmer();
  }

  stemWord(word: string): string {
    return this.#stemmer.stemWord(word);
  }

  stemWords(words: Iterable<string>): string[] {
    return Array.from(words, (word) => this.stemWord(word));
  }
}
