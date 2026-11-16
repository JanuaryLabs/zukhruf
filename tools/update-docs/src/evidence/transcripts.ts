import { glob, readFile, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ClaudeHome } from '../claude-home.ts';
import { under } from '../paths.ts';
import { Since } from '../since.ts';
import type { Project } from '../workspace/project.ts';
import { TEXT_EXCERPT, TOOL_INPUT_EXCERPT, excerpt } from './excerpt.ts';
import type { TranscriptRecord } from './record.ts';
import { TranscriptSelection } from './transcript-selection.ts';

/** A project to find in the transcripts, from a start on. */
export interface Watch {
  readonly project: Project;
  readonly since: Since;
}

type Found = Pick<TranscriptRecord, 'kind' | 'text'>;

/**
 * A session the evidence reads, up to the line `end` (exclusive): its lines
 * from the first /update-docs command on are that run's own work. A session in
 * the workspace gives no tool input, since git history holds the package's own
 * development; a consumer's tool inputs show how it uses the package.
 */
type Session =
  | {
      readonly kind: 'kept';
      readonly cwd: string;
      readonly end: number;
      readonly origin: 'workspace' | 'consumer';
    }
  | { readonly kind: 'dropped' };

// This skill's own runs start with /update-docs, typed (<command-name>) or
// passed to a headless run as the prompt itself.
const UPDATE_DOCS =
  /^\/update-docs(?:\s|$)|<command-name>\/(?:[\w-]+:)?update-docs<\/command-name>/;

/**
 * The Claude Code transcripts of the user's sessions, read once for every
 * watched project. Only what the user said and what the assistant did or
 * wrote is evidence; tool results echo files, and attachments echo context.
 */
export class TranscriptArchive {
  readonly #claude: ClaudeHome;
  readonly #repoRoot: string;
  readonly #selection = new TranscriptSelection();

  constructor(claude: ClaudeHome, repoRoot: string) {
    this.#claude = claude;
    this.#repoRoot = repoRoot;
  }

  async scan(
    watches: readonly Watch[],
  ): Promise<Map<string, TranscriptRecord[]>> {
    const found = new Map<string, TranscriptRecord[]>(
      watches.map(({ project }) => [project.name, []]),
    );
    const files = await this.#files(
      Since.earliest(watches.map(({ since }) => since)),
    );
    const needles = [
      ...new Set(watches.flatMap(({ project }) => project.needles)),
    ].map((needle) => Buffer.from(needle));
    const next = files[Symbol.iterator]();
    const worker = async () => {
      for (const file of next) {
        const buffer = await readFile(join(this.#claude.projects, file));
        if (needles.some((needle) => buffer.includes(needle))) {
          for (const record of this.#records(file, buffer, watches)) {
            found.get(record.project)?.push(record.record);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(16, availableParallelism() * 2) }, worker),
    );
    return new Map(
      [...found].map(([project, records]) => [
        project,
        this.#selection.select(records),
      ]),
    );
  }

  /** The top-level transcripts changed since the start, relative paths. */
  async #files(since: Since): Promise<string[]> {
    const files: string[] = [];
    for await (const file of glob('*/*.jsonl', {
      cwd: this.#claude.projects,
    })) {
      const { mtime } = await stat(join(this.#claude.projects, file));
      if (
        since.includes(Temporal.Instant.fromEpochMilliseconds(mtime.getTime()))
      ) {
        files.push(file);
      }
    }
    return files;
  }

  *#records(
    file: string,
    buffer: Buffer,
    watches: readonly Watch[],
  ): Generator<{ project: string; record: TranscriptRecord }> {
    const lines = buffer.toString('utf8').split('\n');
    const session = this.#session(lines);
    if (session.kind === 'dropped') {
      return;
    }
    const folder = basename(dirname(file));
    for (const [index, line] of lines.slice(0, session.end).entries()) {
      const watching = watches.filter(({ project }) => project.names(line));
      if (watching.length === 0) {
        continue;
      }
      const entry = parse(line);
      if (entry === 'unparsable' || typeof entry.timestamp !== 'string') {
        continue;
      }
      for (const { kind, text } of found(entry)) {
        if (kind === 'tool-input' && session.origin === 'workspace') {
          continue;
        }
        for (const { project, since } of watching) {
          if (project.names(text) && since.includesText(entry.timestamp)) {
            yield {
              project: project.name,
              record: {
                source: 'transcript',
                kind,
                ts: entry.timestamp,
                ref: `${folder}/${basename(file)}:${index + 1}`,
                text: excerpt(
                  text,
                  project.needles,
                  kind === 'tool-input' ? TOOL_INPUT_EXCERPT : TEXT_EXCERPT,
                ),
                session: basename(file, '.jsonl'),
                cwd: session.cwd,
              },
            };
          }
        }
      }
    }
  }

  /**
   * A session is dropped when it ran under ~/.claude (a tool or hook run), or
   * when it records no cwd or no prompt before its first /update-docs.
   */
  #session(lines: readonly string[]): Session {
    let cwd: string | undefined;
    let prompted = false;
    let end = lines.length;
    for (const [index, line] of lines.entries()) {
      if (cwd === undefined && line.includes('"cwd":')) {
        const entry = parse(line);
        if (entry !== 'unparsable' && typeof entry.cwd === 'string') {
          cwd = entry.cwd;
          if (this.#claude.holds(cwd)) {
            return { kind: 'dropped' };
          }
        }
      }
      // After the first prompt, only a line naming the command can end it.
      if (
        line.includes('"type":"user"') &&
        (!prompted || line.includes('update-docs'))
      ) {
        const entry = parse(line);
        const prompt = entry === 'unparsable' ? undefined : userPrompt(entry);
        if (prompt !== undefined && UPDATE_DOCS.test(prompt)) {
          end = index;
          break;
        }
        prompted ||= prompt !== undefined;
      }
    }
    return cwd === undefined || !prompted
      ? { kind: 'dropped' }
      : {
          kind: 'kept',
          cwd,
          end,
          origin: under(cwd, this.#repoRoot) ? 'workspace' : 'consumer',
        };
  }
}

type Entry = Readonly<Record<string, unknown>>;

function parse(line: string): Entry | 'unparsable' {
  try {
    const value: unknown = JSON.parse(line);
    return isEntry(value) ? value : 'unparsable';
  } catch (error) {
    if (error instanceof SyntaxError) {
      return 'unparsable';
    }
    throw error;
  }
}

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text of a prompt the user typed. Meta lines are hook or skill text, and
 * an origin other than human (a task notification) is the harness talking.
 * Transcripts older than the origin field record none, so those are kept.
 */
function userPrompt(entry: Entry): string | undefined {
  if (
    entry.type !== 'user' ||
    entry.isMeta === true ||
    (isEntry(entry.origin) && entry.origin.kind !== 'human')
  ) {
    return undefined;
  }
  const message = entry.message;
  return isEntry(message) && typeof message.content === 'string'
    ? message.content
    : undefined;
}

function* found(entry: Entry): Generator<Found> {
  const prompt = userPrompt(entry);
  if (prompt !== undefined) {
    yield { kind: 'prompt', text: prompt };
    return;
  }
  const message = entry.message;
  if (
    entry.type !== 'assistant' ||
    !isEntry(message) ||
    !Array.isArray(message.content)
  ) {
    return;
  }
  const items: readonly unknown[] = message.content;
  for (const item of items) {
    if (isEntry(item) && item.type === 'tool_use') {
      yield { kind: 'tool-input', text: JSON.stringify(item.input ?? {}) };
    } else if (
      isEntry(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      yield { kind: 'assistant-text', text: item.text };
    }
  }
}
