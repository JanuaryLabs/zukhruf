// Each failure the command line reports, so main.ts can print the message
// and leave the stack out: every one of them is fixed by the caller's input.
export abstract class UpdateDocsError extends Error {}

export class UsageError extends UpdateDocsError {
  override name = 'UsageError';
}

export class UnknownProject extends UpdateDocsError {
  override name = 'UnknownProject';

  constructor(project: string, known: readonly string[]) {
    super(
      `No project under packages/ is named "${project}". Projects: ${known.join(', ')}`,
    );
  }
}

export class ReportInvalid extends UpdateDocsError {
  override name = 'ReportInvalid';
  readonly path: string;

  constructor(file: string, path: string, problem: string) {
    super(`The report ${file} is invalid at ${path}: ${problem}`);
    this.path = path;
  }
}

export class LedgerCorrupt extends UpdateDocsError {
  override name = 'LedgerCorrupt';

  constructor(file: string, path: string, problem: string) {
    super(`The ledger ${file} is invalid at ${path}: ${problem}`);
  }
}

export class ClaimCorrupt extends UpdateDocsError {
  override name = 'ClaimCorrupt';

  constructor(file: string, path: string, problem: string) {
    super(`The claim ${file} is invalid at ${path}: ${problem}`);
  }
}

/** Why `claim` refuses a path; nothing is recorded then. */
export type ClaimRefusal =
  | 'not-markdown'
  | 'outside-project'
  | 'copy-ledger'
  | 'uncommitted'
  | 'claimed';

export class ClaimRefused extends UpdateDocsError {
  override name = 'ClaimRefused';
  readonly path: string;
  readonly refusal: ClaimRefusal;

  constructor(path: string, refusal: ClaimRefusal, detail: string) {
    super(`Cannot claim ${path}: ${detail}`);
    this.path = path;
    this.refusal = refusal;
  }
}

export class ProjectClaimed extends UpdateDocsError {
  override name = 'ProjectClaimed';

  constructor(project: string) {
    super(
      `${project} already has an open claim: commit it or release it first`,
    );
  }
}

export class NoClaim extends UpdateDocsError {
  override name = 'NoClaim';

  constructor(project: string) {
    super(`${project} has no open claim`);
  }
}

export class NotClaimed extends UpdateDocsError {
  override name = 'NotClaimed';

  constructor(project: string, paths: readonly string[]) {
    super(`The claim of ${project} does not hold ${paths.join(', ')}`);
  }
}

export class NotStamped extends UpdateDocsError {
  override name = 'NotStamped';

  constructor(project: string, command: string) {
    super(`${command} needs a stamp: run stamp ${project} first`);
  }
}

/** A claimed path changed after its stamp: a peer edited it, or a writer did. */
export class StampMismatch extends UpdateDocsError {
  override name = 'StampMismatch';
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(
      `Changed after the stamp, so another session may have edited them: ${paths.join(', ')}`,
    );
    this.paths = paths;
  }
}

/** A commit since the claim changed a claimed path, or staged it. */
export class ClaimOvertaken extends UpdateDocsError {
  override name = 'ClaimOvertaken';
  readonly paths: readonly string[];

  constructor(paths: readonly string[], how: string) {
    super(`${how} since the claim: ${paths.join(', ')}`);
    this.paths = paths;
  }
}

export class NothingToCommit extends UpdateDocsError {
  override name = 'NothingToCommit';

  constructor(project: string) {
    super(
      `No claimed path of ${project} differs from HEAD; the claim stays open`,
    );
  }
}

export class SubjectRefused extends UpdateDocsError {
  override name = 'SubjectRefused';

  constructor(text: string, problem: string) {
    super(`The subject "${text}" ${problem}`);
  }
}

/**
 * git commit failed, a hook or a peer's commit most often; nothing was
 * committed, the claimed paths are unstaged again and the claim stays open.
 */
export class CommitRefused extends UpdateDocsError {
  override name = 'CommitRefused';

  constructor(output: string) {
    super(`git commit failed; nothing was committed:\n${output.trimEnd()}`);
  }
}

/** The commit landed but holds more or less than the claim changed. */
export class CommitNotAsClaimed extends UpdateDocsError {
  override name = 'CommitNotAsClaimed';
  readonly sha: string;

  constructor(sha: string, problem: string) {
    super(`Commit ${sha} landed, but ${problem}; check it by hand`);
    this.sha = sha;
  }
}
