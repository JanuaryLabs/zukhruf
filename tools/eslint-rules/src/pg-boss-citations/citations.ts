import type { SourceCode } from 'eslint';

/** One cited range of a pg-boss dist file, at the offsets of its numbers in the text it was read from. */
export interface Citation {
  /** Relative to the dist of pg-boss: `manager.js`, `adapters/pglite.js`. */
  readonly file: string;
  /** The range as the text writes it: `1614-1622` or `83`. */
  readonly range: string;
  readonly first: number;
  readonly last: number;
  readonly start: number;
  readonly end: number;
}

const NUMS = String.raw`\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*`;
// A citation may wrap: `manager.js:` ends one comment line, and its numbers
// start the next one, after `//`, `*`, or `--` in SQL.
const BREAK = String.raw`(?:[ \t]*\n[ \t]*(?:\/\/|\*|--)[ \t]*)?`;
const CITED = new RegExp(
  String.raw`(?<path>[\w./-]*?)(?<file>(?:adapters\/)?[a-zA-Z]+\.js):${BREAK}(?<nums>${NUMS})`,
  'dg',
);
// Numbers that take the file of the citation before them: `(2529, 2607)` on a
// later comment line, and `:166` as in `(plans.js:154, :166)`. A call such as
// `.slice(0, 24)` or `tick(0)` is not one.
const FOLLOW_ON = new RegExp(
  String.raw`(?<![\w$.])\((?<grouped>${NUMS})\)|(?<![\w.]):(?<single>\d+(?:-\d+)?)`,
  'dg',
);
const RANGE = /(?<first>\d+)(?:-(?<last>\d+))?/g;

/**
 * The pg-boss citations of a text: one comment block of a .ts file with its
 * `//` and `*` kept, or a whole Markdown file. A path under node_modules names
 * pg-boss only through `node_modules/pg-boss/`, so a citation of pg,
 * pg-protocol or postgres-date, and the numbers that follow it, are not
 * included.
 */
export function citations(text: string): Citation[] {
  const found: Citation[] = [];
  const matches = [...text.matchAll(CITED)];
  for (const [index, match] of matches.entries()) {
    const { path = '', file = '' } = match.groups ?? {};
    if (
      path.includes('node_modules/') &&
      !path.includes('node_modules/pg-boss/')
    ) {
      continue;
    }
    found.push(...ranges(file, numbersOf(match, 'nums')));
    const end = match.index + match[0].length;
    const next = matches[index + 1]?.index ?? text.length;
    const firstBreak = text.indexOf('\n', end);
    for (const follow of text.slice(end, next).matchAll(FOLLOW_ON)) {
      const grouped = numbersOf(follow, 'grouped');
      const at = end + follow.index;
      if (grouped && (firstBreak === -1 || at < firstBreak)) continue;
      const numbers = grouped ?? numbersOf(follow, 'single');
      if (numbers) {
        found.push(...ranges(file, { ...numbers, start: numbers.start + end }));
      }
    }
  }
  return found;
}

interface Numbers {
  readonly text: string;
  readonly start: number;
}

function numbersOf(match: RegExpExecArray, group: string): Numbers | undefined {
  const text = match.groups?.[group];
  const indices = match.indices?.groups?.[group];
  return text === undefined || indices === undefined
    ? undefined
    : { text, start: indices[0] };
}

function ranges(file: string, numbers: Numbers | undefined): Citation[] {
  if (numbers === undefined) return [];
  return [...numbers.text.matchAll(RANGE)].map((range) => {
    const first = Number(range.groups?.['first']);
    const start = numbers.start + range.index;
    return {
      file,
      range: range[0],
      first,
      last: Number(range.groups?.['last'] ?? first),
      start,
      end: start + range[0].length,
    };
  });
}

interface Block {
  readonly start: number;
  readonly end: number;
  /** Whether the block is of line comments, so that the next line comment can join it. */
  readonly line: boolean;
}

/**
 * The comments of a file, block by block: line comments on adjacent lines
 * make one block, so a citation that wraps onto the next line is read whole.
 */
function commentBlocks(sourceCode: SourceCode): Block[] {
  const blocks: Block[] = [];
  for (const comment of sourceCode.getAllComments()) {
    const [start, end] = sourceCode.getRange(comment);
    const last = blocks.at(-1);
    const line = comment.type === 'Line';
    if (
      line &&
      last?.line === true &&
      /^[ \t]*\r?\n[ \t]*$/.test(sourceCode.text.slice(last.end, start))
    ) {
      blocks[blocks.length - 1] = { ...last, end };
    } else {
      blocks.push({ start, end, line });
    }
  }
  return blocks;
}

// A SQL line comment, and the `--` lines right after it.
const SQL_COMMENT = /--[^\n]*(?:\n[ \t]*--[^\n]*)*/g;

/**
 * The SQL line comments in the strings and template literals of a file, block
 * by block, such as the `-- …` lines of a schema that a template holds.
 */
function sqlCommentBlocks(sourceCode: SourceCode): Block[] {
  return (sourceCode.ast.tokens ?? [])
    .filter((token) => token.type === 'String' || token.type === 'Template')
    .flatMap((token) => {
      const [offset] = sourceCode.getRange(token);
      return [...sourceCode.getText(token).matchAll(SQL_COMMENT)].map(
        (comment): Block => ({
          start: offset + comment.index,
          end: offset + comment.index + comment[0].length,
          line: true,
        }),
      );
    });
}

/**
 * The pg-boss citations in the comments of a parsed file, and in the SQL
 * comments of its strings, at their offsets in the file's text.
 */
export function commentCitations(sourceCode: SourceCode): Citation[] {
  return [...commentBlocks(sourceCode), ...sqlCommentBlocks(sourceCode)]
    .toSorted((a, b) => a.start - b.start)
    .flatMap(({ start, end }) =>
      citations(sourceCode.text.slice(start, end)).map(
        (citation): Citation => ({
          ...citation,
          start: citation.start + start,
          end: citation.end + start,
        }),
      ),
    );
}
