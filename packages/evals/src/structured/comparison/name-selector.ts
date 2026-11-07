// A name selector of RFC 9535 (section 2.3.1): the step to one member of an
// object, as JSONPath text.
export class NameSelector {
  // member-name-shorthand (RFC 9535, section 2.5.1.1): a name that a query
  // can write after "." without quotes.
  static readonly #shorthand =
    '[A-Za-z_\\u{80}-\\u{D7FF}\\u{E000}-\\u{10FFFF}][A-Za-z0-9_\\u{80}-\\u{D7FF}\\u{E000}-\\u{10FFFF}]*';
  static readonly #wholeShorthand = new RegExp(
    `^${NameSelector.#shorthand}$`,
    'u',
  );
  // A Normalized Path (RFC 9535, section 2.7) escapes the control codes, the
  // apostrophe and the backslash. A lone surrogate has no form in JSONPath,
  // so it is escaped as \u too, for people to read.
  static readonly #surrogate = /^\p{Cs}$/u;
  static readonly #escapes: ReadonlyMap<string, string> = new Map([
    ['\b', '\\b'],
    ['\f', '\\f'],
    ['\n', '\\n'],
    ['\r', '\\r'],
    ['\t', '\\t'],
    ["'", "\\'"],
    ['\\', '\\\\'],
  ]);

  // The member-name-shorthand that starts at `at` in `text`, if one does.
  static shorthandAt(text: string, at: number): string | undefined {
    const sticky = new RegExp(NameSelector.#shorthand, 'uy');
    sticky.lastIndex = at;
    return sticky.exec(text)?.[0];
  }

  // The child segment of a member: `.name` when the name is a
  // member-name-shorthand, else the bracketed name selector of a Normalized
  // Path, such as `['a.b']`. The text reads back as the same step, except
  // for a name that holds a lone surrogate, which JSONPath cannot name.
  static segment(name: string): string {
    if (NameSelector.#wholeShorthand.test(name)) return `.${name}`;
    const quoted = [...name].map(
      (character) =>
        NameSelector.#escapes.get(character) ??
        (character < ' ' || NameSelector.#surrogate.test(character)
          ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
          : character),
    );
    return `['${quoted.join('')}']`;
  }
}
