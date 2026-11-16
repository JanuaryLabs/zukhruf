import { join, posix, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { ClaimGuard } from './claims/claim-guard.ts';
import { ClaimStore } from './claims/claim-store.ts';
import { ClaimedPaths } from './claims/claimed-paths.ts';
import { PathCommit } from './claims/path-commit.ts';
import { ClaudeHome } from './claude-home.ts';
import { ClaimCommand } from './commands/claim-command.ts';
import { CommitCommand } from './commands/commit-command.ts';
import { DeltaCommand } from './commands/delta-command.ts';
import { EvidenceCommand } from './commands/evidence-command.ts';
import { FinishCommand } from './commands/finish-command.ts';
import { OpenCommand } from './commands/open-command.ts';
import type { Outcome } from './commands/outcome.ts';
import { ReleaseCommand } from './commands/release-command.ts';
import { ShowCommand } from './commands/show-command.ts';
import { StampCommand } from './commands/stamp-command.ts';
import { UsageError } from './errors.ts';
import { EvidenceBudget } from './evidence/evidence-budget.ts';
import { Evidence } from './evidence/evidence.ts';
import { Git, type Variables } from './git.ts';
import { Ledger } from './ledger/ledger.ts';
import { RunReport } from './ledger/run-report.ts';
import { Since, parseInstant } from './since.ts';
import { Workspace } from './workspace/workspace.ts';

const USAGE = `Usage:
  update-docs evidence <project> [--since <ISO 8601>]
  update-docs delta
  update-docs open
  update-docs show <project>
  update-docs finish <project> --started <ISO 8601> --report <path>
  update-docs claim <project> <path>...
  update-docs stamp <project>
  update-docs commit <project> --subject <text> [--body <text>]
  update-docs release <project> [--revert] [<path>...]`;

export interface Environment {
  /** The user's home folder, which holds ~/.claude. */
  readonly home: string;
  /** The root of the Nx workspace whose packages/ the tool documents. */
  readonly repoRoot: string;
  /** The environment of each process the tool starts: git. */
  readonly variables: Variables;
}

type Options = Record<string, { type: 'string' } | { type: 'boolean' }>;

/** The update-docs command line, given the environment it runs in. */
export class UpdateDocs {
  readonly #claude: ClaudeHome;
  readonly #repoRoot: string;
  readonly #git: Git;
  readonly #workspace: Workspace;

  constructor({ home, repoRoot, variables }: Environment) {
    this.#claude = new ClaudeHome(home);
    this.#repoRoot = repoRoot;
    this.#git = new Git(repoRoot, variables);
    this.#workspace = new Workspace(repoRoot);
  }

  async run(argv: readonly string[]): Promise<Outcome> {
    const [command, ...rest] = argv;
    switch (command) {
      case 'evidence': {
        const { project, values } = this.#withProject(rest, {
          since: { type: 'string' },
        });
        return new EvidenceCommand(
          this.#workspace,
          this.#evidence(),
          new EvidenceBudget(),
        ).run(
          project,
          values.since === undefined
            ? Since.ever
            : Since.from(parseInstant(values.since, '--since')),
        );
      }
      case 'delta': {
        this.#bare(rest);
        return new DeltaCommand(this.#workspace, this.#evidence()).run(
          await this.#ledger(),
        );
      }
      case 'open': {
        this.#bare(rest);
        return new OpenCommand().run(await this.#ledger());
      }
      case 'show': {
        const { project } = this.#withProject(rest, {});
        return new ShowCommand(this.#workspace).run(
          project,
          await this.#ledger(),
        );
      }
      case 'finish': {
        const { project, values } = this.#withProject(rest, {
          started: { type: 'string' },
          report: { type: 'string' },
        });
        if (values.started === undefined || values.report === undefined) {
          throw new UsageError(`finish takes --started and --report\n${USAGE}`);
        }
        return new FinishCommand(
          this.#workspace,
          this.#git,
          join(this.#claude.state, 'runs'),
        ).run(
          project,
          parseInstant(values.started, '--started'),
          await RunReport.read(values.report),
          values.report,
          await this.#ledger(),
        );
      }
      case 'claim': {
        const { project, paths } = this.#withPaths(rest, {});
        if (paths.length === 0) {
          throw new UsageError(`claim takes one path or more\n${USAGE}`);
        }
        return new ClaimCommand(
          this.#workspace,
          new ClaimedPaths(this.#git),
          this.#claims(),
        ).run(project, paths, Temporal.Now.instant());
      }
      case 'stamp': {
        const { project } = this.#withProject(rest, {});
        return new StampCommand(this.#repoRoot, this.#claims()).run(
          project,
          Temporal.Now.instant(),
        );
      }
      case 'commit': {
        const { project, values } = this.#withProject(rest, {
          subject: { type: 'string' },
          body: { type: 'string' },
        });
        if (values.subject === undefined) {
          throw new UsageError(`commit takes --subject\n${USAGE}`);
        }
        const paths = new ClaimedPaths(this.#git);
        return new CommitCommand({
          workspace: this.#workspace,
          store: this.#claims(),
          guard: new ClaimGuard(this.#repoRoot, paths),
          paths,
          committer: new PathCommit(this.#git),
        }).run(
          project,
          values.subject,
          values.body === undefined ? [] : [values.body],
        );
      }
      case 'release': {
        const { project, paths, values } = this.#withPaths(rest, {
          revert: { type: 'boolean' },
        });
        const claimed = new ClaimedPaths(this.#git);
        return new ReleaseCommand(
          this.#claims(),
          new ClaimGuard(this.#repoRoot, claimed),
          claimed,
        ).run(project, values.revert === true ? 'revert' : 'drop', paths);
      }
      default: {
        throw new UsageError(USAGE);
      }
    }
  }

  #evidence(): Evidence {
    return new Evidence(this.#claude, this.#git);
  }

  #ledger(): Promise<Ledger> {
    return Ledger.read(join(this.#claude.state, 'ledger.json'));
  }

  #claims(): ClaimStore {
    return new ClaimStore(join(this.#claude.state, 'claims'));
  }

  /** A command that takes one project and the given options. */
  #withProject<Given extends Options>(args: readonly string[], options: Given) {
    const { project, paths, values } = this.#withPaths(args, options);
    if (paths.length > 0) {
      throw new UsageError(USAGE);
    }
    return { project, values };
  }

  /**
   * A command that takes one project, then paths, each made relative to the
   * workspace with forward slashes, once.
   */
  #withPaths<Given extends Options>(args: readonly string[], options: Given) {
    const { positionals, values } = this.#parse(args, options);
    const [project, ...given] = positionals;
    if (project === undefined) {
      throw new UsageError(USAGE);
    }
    const paths = [
      ...new Set(
        given.map((path) =>
          relative(this.#repoRoot, resolve(this.#repoRoot, path))
            .split(sep)
            .join(posix.sep),
        ),
      ),
    ];
    return { project, paths, values };
  }

  /** A command that takes no argument. */
  #bare(args: readonly string[]): void {
    if (this.#parse(args, {}).positionals.length > 0) {
      throw new UsageError(USAGE);
    }
  }

  #parse<Given extends Options>(args: readonly string[], options: Given) {
    try {
      return parseArgs({
        args: [...args],
        options,
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      if (error instanceof TypeError && 'code' in error) {
        throw new UsageError(`${error.message}\n${USAGE}`);
      }
      throw error;
    }
  }
}
