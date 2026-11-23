import { type Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

// A port of the .dockerignore rules of the Docker CLI. Go keys them on
// os.PathSeparator: on Windows "\" is a separator, as "/" is, and escapes
// nothing; elsewhere "\" escapes the next character. The sources:
// - patternmatcher.go and ignorefile/ignorefile.go of moby/patternmatcher
//   v0.6.1, commit 5a6d8429a19bb6948a372ff19e86fe83599a04b7;
// - ReadDockerignore and TrimBuildFilesFromExcludes of docker/cli
//   cli/command/image/build/dockerignore.go, commit 62881a9b826b;
// - the filter of the walk in Tarballer.Do of moby/go-archive archive.go,
//   commit ca576ae5ca67, lines 880-961;
// - the check of a pattern by Go's filepath.Match (go1.24 path/filepath
//   match.go), and the syntax of Go's regexp that the patterns compile to.
// NOTICE names the licences, and docs/ported-from-moby.md each difference.

/** filepath.ErrBadPattern of Go. */
function badPattern(): SyntaxError {
  return new SyntaxError('syntax error in pattern');
}

/** strings.TrimSpace of Go: Unicode White_Space, not U+FEFF as String.trim. */
function trimSpace(text: string): string {
  return text.replaceAll(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

type Separator = '/' | '\\';

/** Go's os.PathSeparator. */
const separator: Separator = process.platform === 'win32' ? '\\' : '/';

/**
 * filepath.Clean of Go. normalize keeps a trailing separator, which Go drops
 * unless it is the root. On Windows it also turns each "/" into "\".
 */
function clean(path: string): string {
  const platform = separator === '/' ? posix : win32;
  const normal = platform.normalize(path);
  return normal.length > platform.parse(normal).root.length &&
    normal.endsWith(separator)
    ? normal.slice(0, -1)
    : normal;
}

/** filepath.FromSlash of Go. */
function fromSlash(path: string): string {
  return path.replaceAll('/', separator);
}

/** filepath.ToSlash of Go. */
function toSlash(path: string): string {
  return path.replaceAll(separator, '/');
}

/** filepath.Dir of Go, for a path with no volume name. */
function parentOf(path: string): string {
  return clean(path.slice(0, path.lastIndexOf(separator) + 1));
}

/** The code point of one character of a pattern. */
function codePoint(character: string): number {
  return character.codePointAt(0) ?? 0;
}

/**
 * filepath.Match of Go, on code points. patternmatcher.New calls it with the
 * name "." only for its error (patternmatcher.go lines 62-70), so a pattern
 * is malformed when this throws. Go stops at the first chunk that fails, so a
 * later chunk is not checked.
 */
function globMatch(pattern: string[], name: string[]): boolean {
  next: while (pattern.length > 0) {
    const [star, chunk, rest] = scanChunk(pattern);
    pattern = rest;
    if (star && chunk.length === 0) return !name.includes(separator);
    const [remainder, matched] = matchChunk(chunk, name);
    if (matched && (remainder.length === 0 || pattern.length > 0)) {
      name = remainder;
      continue;
    }
    if (star) {
      for (
        let index = 0;
        index < name.length && name[index] !== separator;
        index++
      ) {
        const [after, ok] = matchChunk(chunk, name.slice(index + 1));
        if (ok) {
          if (pattern.length === 0 && after.length > 0) continue;
          name = after;
          continue next;
        }
      }
    }
    return false;
  }
  return name.length === 0;
}

function scanChunk(pattern: string[]): [boolean, string[], string[]] {
  let star = false;
  while (pattern[0] === '*') {
    pattern = pattern.slice(1);
    star = true;
  }
  let inRange = false;
  let index = 0;
  scan: for (; index < pattern.length; index++) {
    switch (pattern[index]) {
      case undefined: {
        break;
      }
      case '\\': {
        if (separator === '/' && index + 1 < pattern.length) index++;
        break;
      }
      case '[': {
        inRange = true;
        break;
      }
      case ']': {
        inRange = false;
        break;
      }
      case '*': {
        if (!inRange) break scan;
      }
    }
  }
  return [star, pattern.slice(0, index), pattern.slice(index)];
}

function matchChunk(chunk: string[], text: string[]): [string[], boolean] {
  // After a failure the loop still reads the chunk, to check its syntax.
  let failed = false;
  while (chunk.length > 0) {
    if (!failed && text.length === 0) failed = true;
    const head = chunk[0];
    if (head === '[') {
      let character: number | undefined;
      if (!failed) {
        character = codePoint(text[0] ?? '');
        text = text.slice(1);
      }
      chunk = chunk.slice(1);
      const negated = chunk[0] === '^';
      if (negated) chunk = chunk.slice(1);
      let matched = false;
      let ranges = 0;
      for (;;) {
        if (chunk[0] === ']' && ranges > 0) {
          chunk = chunk.slice(1);
          break;
        }
        let low: number;
        let high: number;
        [low, chunk] = classCharacter(chunk);
        high = low;
        if (chunk[0] === '-') [high, chunk] = classCharacter(chunk.slice(1));
        if (character !== undefined && low <= character && character <= high) {
          matched = true;
        }
        ranges++;
      }
      if (matched === negated) failed = true;
    } else if (head === '?') {
      if (!failed) {
        if (text[0] === separator) failed = true;
        text = text.slice(1);
      }
      chunk = chunk.slice(1);
    } else {
      if (head === '\\' && separator === '/') {
        chunk = chunk.slice(1);
        if (chunk.length === 0) throw badPattern();
      }
      if (!failed) {
        if (chunk[0] !== text[0]) failed = true;
        text = text.slice(1);
      }
      chunk = chunk.slice(1);
    }
  }
  return failed ? [[], false] : [text, true];
}

/** getEsc of Go's filepath.Match. */
function classCharacter(chunk: string[]): [number, string[]] {
  if (chunk.length === 0 || chunk[0] === '-' || chunk[0] === ']') {
    throw badPattern();
  }
  if (chunk[0] === '\\' && separator === '/') {
    chunk = chunk.slice(1);
    if (chunk.length === 0) throw badPattern();
  }
  const rest = chunk.slice(1);
  if (rest.length === 0) throw badPattern();
  return [codePoint(chunk[0] ?? ''), rest];
}

/**
 * How a pattern matches, as Pattern.compile leaves it: a Go regexp (`source`
 * is its string), or an exact, prefix or suffix comparison.
 */
export type CompiledPattern =
  | { kind: 'exact' }
  | { kind: 'prefix' }
  | { kind: 'suffix' }
  | { kind: 'regexp'; source: string; expression: RegExp };

/**
 * Pattern.compile(sl) of patternmatcher.go (lines 345-440), with the separator
 * as its argument, as in Go: Pattern.match gives it os.PathSeparator. The
 * regexp string is built as Go builds it, and then read with Go's regexp
 * syntax, so a malformed regexp throws here, as regexp.Compile fails in Go.
 */
export function compile(
  pattern: string,
  separator: Separator,
): CompiledPattern {
  const characters = [...pattern];
  // text/scanner drops a byte order mark at the start.
  if (characters[0] === '\u{FEFF}') characters.shift();
  // The separator as a regexp: "\\" on Windows.
  const escapedSeparator = separator === '/' ? '/' : '\\\\';
  let source = '^';
  let kind: 'exact' | 'prefix' | 'suffix' | 'regexp' = 'exact';
  let next = 0;
  for (let index = 0; next < characters.length; index++) {
    const character = characters[next++];
    if (character === '*') {
      if (characters[next] === '*') {
        next++;
        // "**/" is "**".
        if (characters[next] === separator) next++;
        if (next === characters.length) {
          if (kind === 'exact') {
            kind = 'prefix';
          } else {
            source += '.*';
            kind = 'regexp';
          }
        } else {
          source += `(.*${escapedSeparator})?`;
          kind = 'regexp';
        }
        // Go sets this after the lines above: "**" and "**/x" compare suffixes.
        if (index === 0) kind = 'suffix';
      } else {
        source += `[^${escapedSeparator}]*`;
        kind = 'regexp';
      }
    } else if (character === '?') {
      source += `[^${escapedSeparator}]`;
      kind = 'regexp';
    } else if (character !== undefined && '.+()|{}$'.includes(character)) {
      source += `\\${character}`;
    } else if (character === '\\' && separator === '\\') {
      // On Windows "\" is the separator, and filepath.Match has no escape.
      source += escapedSeparator;
    } else if (character === '\\') {
      // A trailing "\" stays, and then escapes the "$" that ends the regexp.
      if (next < characters.length) {
        source += `\\${characters[next++]}`;
        kind = 'regexp';
      } else {
        source += '\\';
      }
    } else if (character === '[' || character === ']') {
      source += character;
      kind = 'regexp';
    } else {
      source += character;
    }
  }
  if (kind !== 'regexp') return { kind };
  source += '$';
  return { kind, source, expression: goRegExp(source) };
}

/**
 * The regexp of Go's syntax (regexp/syntax, Perl flags) that compile builds,
 * as a JavaScript RegExp. compile escapes each of `.+()|{}$`, so the source has
 * literals, classes, escapes, `^`, `$`, and the stars, groups and dots that
 * compile writes itself.
 * Go gives an escaped letter or digit (`\d`, `\pL`, `\x41`) and a POSIX class
 * (`[[:alpha:]]`) a meaning that filepath.Match does not; this port refuses
 * them as malformed, so that no folder sends other files than the CLI sends.
 */
function goRegExp(source: string): RegExp {
  const characters = [...source];
  let index = 0;
  const literal = (character: string) =>
    `\\u{${codePoint(character).toString(16)}}`;
  const escaped = (): string => {
    const character = characters[index + 1];
    index += 2;
    // Go: an escaped ASCII character that is not a letter or digit is itself.
    if (
      character !== undefined &&
      codePoint(character) < 0x80 &&
      !/[\dA-Za-z]/.test(character)
    ) {
      return character;
    }
    throw badPattern();
  };
  const classCharacterOfRegExp = (): string => {
    if (characters[index] === '\\') return escaped();
    const character = characters[index++];
    if (character === undefined) throw badPattern();
    return character;
  };
  const characterClass = (): string => {
    index++;
    const negated = characters[index] === '^';
    if (negated) index++;
    let body = '';
    // Go's parseClass: "]" is a literal as the first character of a class.
    let first = true;
    while (first || characters[index] !== ']') {
      if (index >= characters.length) throw badPattern();
      first = false;
      if (
        characters[index] === '[' &&
        characters[index + 1] === ':' &&
        characters
          .slice(index + 2)
          .join('')
          .includes(':]')
      ) {
        throw badPattern();
      }
      const low = classCharacterOfRegExp();
      let high = low;
      if (
        characters[index] === '-' &&
        index + 1 < characters.length &&
        characters[index + 1] !== ']'
      ) {
        index++;
        // A range out of order fails in the RegExp below, as in parseClass.
        high = classCharacterOfRegExp();
      }
      body += `${literal(low)}-${literal(high)}`;
    }
    index++;
    return `[${negated ? '^' : ''}${body}]`;
  };
  let output = '';
  while (index < characters.length) {
    const character = characters[index] ?? '';
    if (character === '\\') {
      output += literal(escaped());
    } else if (character === '[') {
      output += characterClass();
    } else if (character === '.') {
      // Go's "." matches each character but "\n"; JavaScript's skips "\r" too.
      output += String.raw`[^\n]`;
      index++;
    } else if ('^$()*?'.includes(character)) {
      output += character;
      index++;
    } else {
      output += literal(character);
      index++;
    }
  }
  try {
    return new RegExp(output, 'u');
  } catch {
    throw badPattern();
  }
}

class Pattern {
  readonly text: string;
  readonly exclusion: boolean;
  #compiled: CompiledPattern | undefined;

  constructor(text: string, exclusion: boolean) {
    this.text = text;
    this.exclusion = exclusion;
  }

  /** Go compiles a pattern at its first match, so its error comes then. */
  match(path: string): boolean {
    this.#compiled ??= compile(this.text, separator);
    switch (this.#compiled.kind) {
      case 'exact': {
        return path === this.text;
      }
      case 'prefix': {
        return path.startsWith(this.text.slice(0, -2));
      }
      case 'suffix': {
        const suffix = this.text.slice(2);
        // "**/foo" also matches "foo".
        return (
          path.endsWith(suffix) ||
          (suffix[0] === separator && path === suffix.slice(1))
        );
      }
      case 'regexp': {
        return this.#compiled.expression.test(path);
      }
    }
  }
}

/** patternmatcher.New. */
function compilePatterns(patterns: readonly string[]): Pattern[] {
  const compiled: Pattern[] = [];
  for (const line of patterns) {
    let pattern = trimSpace(line);
    if (pattern === '') continue;
    pattern = clean(pattern);
    const exclusion = pattern.startsWith('!');
    if (exclusion) {
      if (pattern.length === 1) {
        throw new SyntaxError('illegal exclusion pattern: "!"');
      }
      pattern = pattern.slice(1);
    }
    globMatch([...pattern], ['.']);
    compiled.push(new Pattern(pattern, exclusion));
  }
  return compiled;
}

/** Each parent folder of `path`, from the top. */
function parentsOf(path: string): string[] {
  const parent = parentOf(path);
  if (parent === '.') return [];
  const names = parent.split(separator);
  return names.map((_, index) => names.slice(0, index + 1).join(separator));
}

/**
 * MatchesUsingParentResults (patternmatcher.go lines 216-272). An exclusion
 * is read only when a pattern before it matched, an inclusion only when none
 * did, so the last pattern that matches decides. With no results of the
 * parent folder, a pattern that matches a parent folder matches the path.
 */
function evaluate(
  patterns: readonly Pattern[],
  path: string,
  parent?: readonly boolean[],
): { excluded: boolean; matched: boolean[] } {
  const file = fromSlash(path);
  let excluded = false;
  const matched = patterns.map(() => false);
  for (const [index, pattern] of patterns.entries()) {
    let match = parent?.[index] ?? false;
    if (!match) {
      if (pattern.exclusion !== excluded) continue;
      match = pattern.match(file);
      if (!match && parent === undefined) {
        match = parentsOf(file).some((folder) => pattern.match(folder));
      }
    }
    matched[index] = match;
    if (match) excluded = !pattern.exclusion;
  }
  return { excluded, matched };
}

/**
 * Whether the .dockerignore `patterns` exclude `path`, a path in the context
 * with "/" between its names: MatchesOrParentMatches of patternmatcher. It
 * throws a SyntaxError for a malformed pattern.
 */
export function matches(path: string, patterns: readonly string[]): boolean {
  const compiled = compilePatterns(patterns);
  const file = clean(path);
  // "Don't let them exclude everything, kind of silly." (line 471)
  if (file === '.') return false;
  return evaluate(compiled, file).excluded;
}

/**
 * The deprecated Matches of patternmatcher (lines 88-120 and 447-460), which
 * TrimBuildFilesFromExcludes calls: it reads one parent folder, as deep as
 * the pattern, and an error gives false.
 */
function matchesOneParent(path: string, patterns: readonly string[]): boolean {
  let compiled: Pattern[];
  try {
    compiled = compilePatterns(patterns);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  const file = fromSlash(clean(path));
  if (file === '.') return false;
  const parent = parentOf(file);
  const folders = parent.split(separator);
  let excluded = false;
  for (const pattern of compiled) {
    if (pattern.exclusion !== excluded) continue;
    let match: boolean;
    try {
      match = pattern.match(file);
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    const depth = pattern.text.split(separator).length;
    if (!match && parent !== '.' && depth <= folders.length) {
      match = pattern.match(folders.slice(0, depth).join(separator));
    }
    if (match) excluded = !pattern.exclusion;
  }
  return excluded;
}

/**
 * The patterns of the .dockerignore file in `directory`, as ReadDockerignore
 * and ignorefile.ReadAll give them: no byte order mark, no "#" comment line,
 * no blank line, each pattern trimmed and cleaned, with no leading "/", and
 * "!" kept. No file gives no patterns.
 */
export async function readDockerignore(directory: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(directory, '.dockerignore'), 'utf8');
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const patterns: string[] = [];
  // bufio.ScanLines: a line ends at "\n". The "\r" before it, which ScanLines
  // drops, goes in trimSpace, and does not change which line is a comment.
  for (const line of text.replace(/^\u{FEFF}/u, '').split('\n')) {
    // A comment is a line that starts with "#" before the line is trimmed.
    if (line.startsWith('#')) continue;
    let pattern = trimSpace(line);
    if (pattern === '') continue;
    const exclusion = pattern.startsWith('!');
    if (exclusion) pattern = trimSpace(pattern.slice(1));
    if (pattern.length > 0) {
      pattern = toSlash(clean(pattern));
      if (pattern.length > 1 && pattern.startsWith('/')) {
        pattern = pattern.slice(1);
      }
    }
    patterns.push(exclusion ? `!${pattern}` : pattern);
  }
  return patterns;
}

/**
 * TrimBuildFilesFromExcludes: the Dockerfile and .dockerignore are always
 * sent, so an exception is added for each one that the patterns exclude.
 */
function keepBuildFiles(
  patterns: readonly string[],
  dockerfile: string,
): string[] {
  const kept = [...patterns];
  if (matchesOneParent('.dockerignore', kept)) kept.push('!.dockerignore');
  const name = toSlash(dockerfile);
  if (matchesOneParent(name, kept)) kept.push(`!${name}`);
  return kept;
}

/** Go's os.ReadDir order: by the bytes of the names. */
function byName(left: Dirent, right: Dirent): number {
  return Buffer.compare(Buffer.from(left.name), Buffer.from(right.name));
}

/**
 * The paths of the build context in `directory` that the Docker CLI sends,
 * in its order: each folder, file and symbolic link that the .dockerignore of
 * the folder does not exclude, with "/" between names, and always
 * `dockerfile` (a path in the context) and .dockerignore. A link is not
 * followed. An excluded folder is read only when an exception pattern starts
 * with its path, because a file in it can be sent again.
 */
export async function* contextPaths(
  directory: string,
  dockerfile: string,
): AsyncGenerator<string> {
  const patterns = compilePatterns(
    keepBuildFiles(await readDockerignore(directory), dockerfile),
  );
  const exceptions = patterns.filter((pattern) => pattern.exclusion);
  async function* walk(
    folder: string,
    relative: string,
    parent: readonly boolean[] | undefined,
  ): AsyncGenerator<string> {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort(byName)) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const { excluded, matched } = evaluate(patterns, path, parent);
      if (excluded) {
        const folderPath = `${fromSlash(path)}${separator}`;
        // archive.go lines 931-961: an excluded folder is skipped unless an
        // exception pattern starts with its path.
        if (
          entry.isDirectory() &&
          exceptions.some((pattern) =>
            `${pattern.text}${separator}`.startsWith(folderPath),
          )
        ) {
          yield* walk(join(folder, entry.name), path, matched);
        }
        continue;
      }
      yield path;
      if (entry.isDirectory()) {
        yield* walk(join(folder, entry.name), path, matched);
      }
    }
  }
  yield* walk(directory, '', undefined);
}
