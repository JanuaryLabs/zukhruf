import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { ClaimCorrupt, NoClaim, ProjectClaimed } from '../errors.ts';
import { ROOT, Shape } from '../ledger/shape.ts';
import { Claim, type Stamp } from './claim.ts';
import { formatPathState, parsePathState } from './path-state.ts';

/**
 * The open claims, one file per project, so creating a claim is one
 * exclusive create: two runs of one project cannot both hold a claim.
 */
export class ClaimStore {
  readonly #folder: string;

  constructor(folder: string) {
    this.#folder = folder;
  }

  /** Records a new claim; a project with an open claim refuses another. */
  async create(claim: Claim): Promise<void> {
    await mkdir(this.#folder, { recursive: true });
    try {
      await writeFile(this.#file(claim.project), serialize(claim), {
        flag: 'wx',
      });
    } catch (error) {
      if (Error.isError(error) && 'code' in error && error.code === 'EEXIST') {
        throw new ProjectClaimed(claim.project);
      }
      throw error;
    }
  }

  async read(project: string): Promise<Claim> {
    const file = this.#file(project);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        throw new NoClaim(project);
      }
      throw error;
    }
    return parse(file, text);
  }

  /** Every open claim; before the first claim there are none. */
  async all(): Promise<Claim[]> {
    let names: string[];
    try {
      names = await readdir(this.#folder);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .map((name) => this.read(name.slice(0, -'.json'.length))),
    );
  }

  /** Writes a temporary file beside the claim, then renames it over it. */
  async replace(claim: Claim): Promise<void> {
    const temporary = join(this.#folder, `.claim-${randomUUID()}.json`);
    await writeFile(temporary, serialize(claim));
    await rename(temporary, this.#file(claim.project));
  }

  async remove(project: string): Promise<void> {
    await rm(this.#file(project));
  }

  #file(project: string): string {
    return join(this.#folder, `${project}.json`);
  }
}

function serialize(claim: Claim): string {
  const stamp =
    claim.stamp.kind === 'none'
      ? { kind: 'none' }
      : {
          kind: 'taken',
          at: claim.stamp.at,
          states: Object.fromEntries(
            [...claim.stamp.states].map(([path, state]) => [
              path,
              formatPathState(state),
            ]),
          ),
        };
  return `${JSON.stringify(
    {
      project: claim.project,
      paths: claim.paths,
      head: claim.head,
      at: claim.at,
      stamp,
    },
    null,
    2,
  )}\n`;
}

function parse(file: string, text: string): Claim {
  const shape = new Shape(
    (path, problem) => new ClaimCorrupt(file, path, problem),
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ClaimCorrupt(file, 'the document', error.message);
    }
    throw error;
  }
  const claim = shape.object(value, ROOT, [
    'project',
    'paths',
    'head',
    'at',
    'stamp',
  ]);
  const stampValue = shape.record(claim.get('stamp'), 'stamp');
  let stamp: Stamp;
  if (stampValue.kind === 'none') {
    shape.object(stampValue, 'stamp', ['kind']);
    stamp = { kind: 'none' };
  } else {
    const taken = shape.object(stampValue, 'stamp', ['kind', 'at', 'states']);
    shape.oneOf(taken.get('kind'), 'stamp.kind', ['none', 'taken']);
    const states = shape.record(taken.get('states'), 'stamp.states');
    stamp = {
      kind: 'taken',
      at: shape.instant(taken.get('at'), 'stamp.at'),
      states: new Map(
        Object.entries(states).map(([path, each]) => {
          const at = `stamp.states.${path}`;
          const state = parsePathState(shape.text(each, at));
          if (state === 'invalid') {
            throw new ClaimCorrupt(file, at, 'expected absent or sha256:<hex>');
          }
          return [path, state];
        }),
      ),
    };
  }
  return new Claim({
    project: shape.text(claim.get('project'), 'project'),
    paths: shape.list(claim.get('paths'), 'paths', (each, at) =>
      shape.text(each, at),
    ),
    head: shape.text(claim.get('head'), 'head'),
    at: shape.instant(claim.get('at'), 'at'),
    stamp,
  });
}

function isMissing(error: unknown): boolean {
  return Error.isError(error) && 'code' in error && error.code === 'ENOENT';
}
