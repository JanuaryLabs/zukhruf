import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// A top-level key of an .npmrc, as npm's ini reads it, with the comment lines
// right above it.
interface Setting {
  readonly values: readonly string[];
  readonly comment: string;
}

// The value of a line after its `=`, as npm's ini reads it (ini 5,
// lib/ini.js `unsafe`): a quoted value loses its quotes; an unquoted one ends
// at the first `;` or `#` that no backslash escapes.
function iniValue(raw: string): string {
  const value = raw.trim();
  if (/^(".*"|'.*')$/.test(value)) return value.slice(1, -1);
  let unescaped = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      unescaped += ';#\\'.includes(character) ? character : `\\${character}`;
      escaped = false;
    } else if (character === ';' || character === '#') break;
    else if (character === '\\') escaped = true;
    else unescaped += character;
  }
  return (escaped ? `${unescaped}\\` : unescaped).trim();
}

// The top-level keys of an .npmrc: those above its first `[section]`. A line
// without `=` sets its key to true. Comment lines start with `;` or `#`.
function settings(npmrc: string): Map<string, Setting> {
  const found = new Map<string, { values: string[]; comment: string }>();
  let comment: string[] = [];
  for (const line of npmrc.split(/\r?\n/)) {
    if (/^\[[^\]]*\]\s*$/.test(line)) break;
    if (/^\s*$/.test(line)) {
      comment = [];
      continue;
    }
    if (/^\s*[;#]/.test(line)) {
      comment.push(line);
      continue;
    }
    const equals = line.indexOf('=');
    const key = (equals === -1 ? line : line.slice(0, equals)).trim();
    const value = equals === -1 ? 'true' : iniValue(line.slice(equals + 1));
    const setting = found.get(key) ?? { values: [], comment: '' };
    setting.values.push(value);
    setting.comment = comment.join('\n');
    found.set(key, setting);
    comment = [];
  }
  return found;
}

// Every repo commits an .npmrc that decides two things for each install, so
// the user's ~/.npmrc never does: peers resolve for real
// (legacy-peer-deps=false), and an install fails when a dependency has an
// install script that allowScripts does not name (strict-allow-scripts=true).
// legacy-peer-deps=true is allowed only under a comment that names the peer
// conflict and the backlog item that tracks it (#<id>).
export class NpmrcPolicy extends Step<Commit> {
  readonly name = 'npmrc';

  async run(commit: Commit): Promise<Outcome> {
    const npmrc = await (await commit.tree()).read('.npmrc');
    if (npmrc === undefined)
      return this.fail(
        'the commit has no .npmrc. Add one with legacy-peer-deps=false and strict-allow-scripts=true, and commit again.',
      );
    const found = settings(npmrc);
    const problems: string[] = [];
    const peers = found.get('legacy-peer-deps');
    if (peers === undefined) problems.push('no legacy-peer-deps');
    else if (peers.values.length > 1)
      problems.push(
        `legacy-peer-deps set ${peers.values.length} times; npm reads a repeated key as a list`,
      );
    else if (peers.values[0] === 'true' && !/#\d+/.test(peers.comment))
      problems.push(
        'legacy-peer-deps=true without a comment above it that names the peer conflict and its backlog item (#<id>)',
      );
    else if (peers.values[0] !== 'true' && peers.values[0] !== 'false')
      problems.push(`legacy-peer-deps=${peers.values[0]}: write false`);
    const scripts = found.get('strict-allow-scripts');
    if (scripts === undefined) problems.push('no strict-allow-scripts');
    else if (scripts.values.length > 1)
      problems.push(
        `strict-allow-scripts set ${scripts.values.length} times; npm reads a repeated key as a list`,
      );
    else if (scripts.values[0] !== 'true')
      problems.push(`strict-allow-scripts=${scripts.values[0]}: write true`);
    if (problems.length === 0)
      return this.pass(
        peers?.values[0] === 'true'
          ? 'legacy-peer-deps=true under its backlog item, and strict-allow-scripts=true'
          : 'legacy-peer-deps=false and strict-allow-scripts=true',
      );
    return this.fail(
      [
        'The staged .npmrc does not decide how npm installs:',
        ...problems.map((problem) => `  .npmrc  ${problem}`),
        'Write legacy-peer-deps=false and strict-allow-scripts=true, once each, above any [section]. legacy-peer-deps=true goes under a comment that names the peer conflict and its backlog item (#<id>).',
      ].join('\n'),
    );
  }
}
