import type { PathState } from './path-state.ts';

/** The content of each claimed path when the writers finished. */
export type Stamp =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'taken';
      readonly at: string;
      readonly states: ReadonlyMap<string, PathState>;
    };

/**
 * The Markdown paths one run of a project may write and commit. Each path was
 * clean at `head` when it was claimed, so its content at `head` is what the
 * run started from.
 */
export class Claim {
  readonly project: string;
  readonly paths: readonly string[];
  readonly head: string;
  readonly at: string;
  readonly stamp: Stamp;

  constructor(
    fields: Pick<Claim, 'project' | 'paths' | 'head' | 'at' | 'stamp'>,
  ) {
    this.project = fields.project;
    this.paths = fields.paths;
    this.head = fields.head;
    this.at = fields.at;
    this.stamp = fields.stamp;
  }

  stamped(at: string, states: ReadonlyMap<string, PathState>): Claim {
    return new Claim({ ...this, stamp: { kind: 'taken', at, states } });
  }

  /** The claim without the released paths, or 'empty' when none is left. */
  without(released: readonly string[]): Claim | 'empty' {
    const paths = this.paths.filter((path) => !released.includes(path));
    if (paths.length === 0) {
      return 'empty';
    }
    const stamp: Stamp =
      this.stamp.kind === 'none'
        ? this.stamp
        : {
            ...this.stamp,
            states: new Map(
              [...this.stamp.states].filter(([path]) => paths.includes(path)),
            ),
          };
    return new Claim({ ...this, paths, stamp });
  }
}
