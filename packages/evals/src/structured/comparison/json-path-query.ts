import { Field, type FieldStep } from './field.ts';
import { NameSelector } from './name-selector.ts';

// A JSONPath query (RFC 9535) that names one field: the root identifier `$`,
// then child segments that hold one name selector (`.name`, `['name']`,
// `["name"]`) or the wildcard selector (`[*]`, `.*`), which selects every item
// of an array. Any other query throws a SyntaxError: a descendant segment, an
// index, a slice, a filter, or more than one selector in a segment.
export class JsonPathQuery {
  static readonly #blank = new Set([' ', '\t', '\n', '\r']);
  static readonly #escapes: ReadonlyMap<string | undefined, string> = new Map([
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
    ['/', '/'],
    ['\\', '\\'],
  ]);

  readonly field: Field;
  readonly #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
    this.field = new Field(this.#query());
  }

  #query(): FieldStep[] {
    this.#expect('$');
    const steps: FieldStep[] = [];
    for (;;) {
      const segmentAt = this.#at;
      this.#skipBlank();
      if (this.#at === this.#text.length) {
        if (this.#at > segmentAt) this.#fail(segmentAt);
        return steps;
      }
      steps.push(this.#segment());
    }
  }

  #segment(): FieldStep {
    if (this.#take('.')) {
      if (this.#take('*')) return Field.item;
      const name = NameSelector.shorthandAt(this.#text, this.#at);
      if (name === undefined) this.#fail(this.#at);
      this.#at += name.length;
      return name;
    }
    this.#expect('[');
    this.#skipBlank();
    const step = this.#take('*') ? Field.item : this.#string();
    this.#skipBlank();
    this.#expect(']');
    return step;
  }

  // A string-literal (RFC 9535, section 2.3.1.1), in single or double quotes.
  #string(): string {
    const quote = this.#text[this.#at];
    if (quote !== "'" && quote !== '"') this.#fail(this.#at);
    this.#at++;
    let name = '';
    for (;;) {
      const at = this.#at;
      const character = this.#text.codePointAt(at);
      if (character === undefined) this.#fail(at);
      const text = String.fromCodePoint(character);
      this.#at += text.length;
      if (text === quote) return name;
      if (text === '\\') name += this.#escape(quote);
      else if (character < 0x20 || /\p{Cs}/u.test(text)) this.#fail(at);
      else name += text;
    }
  }

  #escape(quote: string): string {
    const at = this.#at;
    const letter = this.#text[at];
    this.#at++;
    if (letter === quote) return quote;
    if (letter === 'u') return this.#unicode(at);
    const character = JsonPathQuery.#escapes.get(letter);
    if (character === undefined) this.#fail(at);
    return character;
  }

  // \uXXXX, where a high surrogate needs a \u low surrogate after it.
  #unicode(at: number): string {
    const high = this.#hex();
    if (high >= 0xdc00 && high <= 0xdfff) this.#fail(at);
    if (high < 0xd800 || high > 0xdbff) return String.fromCharCode(high);
    if (!this.#take('\\') || !this.#take('u')) this.#fail(at);
    const low = this.#hex();
    if (low < 0xdc00 || low > 0xdfff) this.#fail(at);
    return String.fromCharCode(high, low);
  }

  #hex(): number {
    const digits = this.#text.slice(this.#at, this.#at + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) this.#fail(this.#at);
    this.#at += 4;
    return Number.parseInt(digits, 16);
  }

  #skipBlank(): void {
    while (JsonPathQuery.#blank.has(this.#text[this.#at] ?? '')) this.#at++;
  }

  #take(character: string): boolean {
    if (this.#text[this.#at] !== character) return false;
    this.#at++;
    return true;
  }

  #expect(character: string): void {
    if (!this.#take(character)) this.#fail(this.#at);
  }

  #fail(at: number): never {
    throw new SyntaxError(
      `${JSON.stringify(this.#text)} is not a field at character ${at}: write a JSONPath query (RFC 9535) of "$" and child segments that each hold a name selector or the wildcard selector, such as "$.offers[*].value.amount" or "$['a.b']"`,
    );
  }
}
