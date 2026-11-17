import { existsSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

/** A file that one command of a target hands to Node, with the conditions it resolves packages under. */
export interface Script {
  readonly file: string;
  readonly conditions: readonly string[];
}

const RUNNERS = new Set(['node', 'tsx']);

// Node flags whose value is the next word: the value is never the script.
const VALUE_FLAGS = new Set([
  '--import',
  '-r',
  '--require',
  '--env-file',
  '--env-file-if-exists',
  '--loader',
  '--experimental-loader',
  '--input-type',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--watch-path',
  '--tsconfig',
]);

const SCRIPT = /\.(?:[cm]?ts|[cm]?js)$/;
const GLOB = /[*?[{]/;
const OPERATOR = /^(?:&&|\|\||[;|&\n])/;
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * The simple commands of a shell command line, each as its words: quotes are
 * removed, and `&&`, `||`, `;`, `|` and `&` end a command.
 */
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [[]];
  let word: string | undefined;
  let quote: string | undefined;
  const endWord = () => {
    if (word !== undefined) commands.at(-1)?.push(word);
    word = undefined;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && index + 1 < line.length) {
        index++;
        word = (word ?? '') + line.charAt(index);
      } else word = (word ?? '') + char;
      continue;
    }
    const operator = OPERATOR.exec(line.slice(index))?.[0];
    if (operator) {
      endWord();
      commands.push([]);
      index += operator.length - 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (char === '\\' && index + 1 < line.length) {
      index++;
      word = (word ?? '') + line.charAt(index);
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word = (word ?? '') + char;
    }
  }
  endWord();
  return commands.filter((words) => words.length > 0);
}

function scriptsOf(words: string[], cwd: string): Script[] {
  let index = 0;
  while (ENV_ASSIGNMENT.test(words[index] ?? '')) index++;
  if (words[index] === 'npx') index++;
  if (!RUNNERS.has(words[index] ?? '')) return [];
  const conditions: string[] = [];
  const positionals: string[] = [];
  let test = false;
  for (index++; index < words.length; index++) {
    const word = words[index] ?? '';
    if (word === '--test') {
      test = true;
    } else if (word === '--conditions' || word === '-C') {
      index++;
      conditions.push(words[index] ?? '');
    } else if (word.startsWith('--conditions=')) {
      conditions.push(word.slice('--conditions='.length));
    } else if (VALUE_FLAGS.has(word)) {
      index++;
    } else if (!word.startsWith('-')) {
      positionals.push(word);
      // Without --test the first positional is the script; the rest are its arguments.
      if (!test) break;
    }
  }
  const files = test
    ? positionals.flatMap((word) =>
        GLOB.test(word) ? globSync(word, { cwd }) : [word],
      )
    : positionals.slice(0, 1);
  return files
    .filter((file) => SCRIPT.test(file))
    .map((file) => resolve(cwd, file))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, conditions }));
}

/**
 * The files that `line`, run from `cwd`, hands to `node` or `tsx` as the
 * script, and the test files of `node --test`, globs expanded as Node expands
 * them. With `node -e`, the code is the first positional, so no file runs.
 */
export function scriptsRun(line: string, cwd: string): Script[] {
  return simpleCommands(line).flatMap((words) => scriptsOf(words, cwd));
}
