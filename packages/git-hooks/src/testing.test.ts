import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import type { CommitMessage } from './commit-message.ts';
import type { Commit } from './commit.ts';
import type { Push } from './push.ts';
import { Step } from './step.ts';
import { commitMsg, preCommit, prePush } from './testing.ts';
import { isolatedEnvironment } from './testing/hooked-repository.ts';

test('preCommit: a step that stages another file while it runs passes, and the outcomes end with the fail that stops the commit', async () => {
  // Arrange
  await using top = await new TemporaryFiles().directory('testing-');
  const environment = isolatedEnvironment(top.path);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: top.path, env: environment });
  git('init', '--quiet');
  await writeFile(join(top.path, 'a.txt'), 'a\n');
  await writeFile(join(top.path, 'b.txt'), 'b\n');
  git('add', 'a.txt');
  class StagesAnother extends Step<Commit> {
    readonly name = 'stages';
    async run() {
      git('add', 'b.txt');
      return this.pass();
    }
  }

  // Act
  const outcomes = await preCommit({ root: top.path, environment }, [
    new StagesAnother(),
  ]);

  // Assert
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.kind, 'pass');
  assert.equal(outcomes[1]?.kind, 'fail');
  assert.match(
    outcomes[1]?.message ?? '',
    /the index changed while the hook ran/,
  );
});

test('preCommit: a failing step is the last outcome, no step after it runs, and no second outcome says that the commit stops', async () => {
  // Arrange
  await using top = await new TemporaryFiles().directory('testing-');
  const environment = isolatedEnvironment(top.path);
  execFileSync('git', ['init', '--quiet'], { cwd: top.path, env: environment });
  let ranAfter = false;
  class Fails extends Step<Commit> {
    readonly name = 'fails';
    async run() {
      return this.fail('no');
    }
  }
  class After extends Step<Commit> {
    readonly name = 'after';
    async run() {
      ranAfter = true;
      return this.pass();
    }
  }

  // Act
  const outcomes = await preCommit({ root: top.path, environment }, [
    new Fails(),
    new After(),
  ]);

  // Assert
  assert.deepEqual(outcomes, [{ kind: 'fail', message: 'no' }]);
  assert.equal(ranAfter, false);
});

test('prePush: a step sees the remote and each ref update of the input: an update based on the remote sha, a new branch based on the parent of its first commit that the remote has not seen, and a deletion', async () => {
  // Arrange
  await using top = await new TemporaryFiles().directory('testing-');
  const environment = isolatedEnvironment(top.path);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: top.path,
      env: environment,
      encoding: 'utf8',
    }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('commit', '--quiet', '--allow-empty', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  git('commit', '--quiet', '--allow-empty', '-m', 'third');
  const third = git('rev-parse', 'HEAD');
  // The remote has seen only the first commit.
  git('update-ref', 'refs/remotes/origin/main', first);
  const none = '0'.repeat(first.length);
  class Records extends Step<Push> {
    readonly name = 'records';
    async run(push: Push) {
      return this.pass(
        JSON.stringify({
          remote: push.remote,
          updates: push.updates.map((update) =>
            update.kind === 'delete'
              ? [update.kind, update.remoteRef]
              : [update.kind, update.head, update.base],
          ),
        }),
      );
    }
  }

  // Act
  const [outcome] = await prePush(
    {
      root: top.path,
      environment,
      remote: { name: 'origin', url: 'https://example.com/repo.git' },
      input: [
        `refs/heads/main ${third} refs/heads/main ${second}`,
        `refs/heads/topic ${third} refs/heads/topic ${none}`,
        `(delete) ${none} refs/heads/old ${first}`,
        '',
      ].join('\n'),
    },
    [new Records()],
  );

  // Assert
  assert.equal(outcome?.kind, 'pass');
  assert.deepEqual(JSON.parse(outcome.message), {
    remote: { name: 'origin', url: 'https://example.com/repo.git' },
    updates: [
      ['update', third, second],
      ['create', third, first],
      ['delete', 'refs/heads/old'],
    ],
  });
});

test('commitMsg: a step sees the message in the file without the comment lines of the editor', async () => {
  // Arrange
  await using top = await new TemporaryFiles().directory('testing-');
  const environment = isolatedEnvironment(top.path);
  execFileSync('git', ['init', '--quiet'], { cwd: top.path, env: environment });
  const file = join(top.path, 'COMMIT_EDITMSG');
  await writeFile(
    file,
    'feat: one\n# Please enter the commit message\n\nThe body.\n# On branch main\n',
  );
  class Records extends Step<CommitMessage> {
    readonly name = 'records';
    async run(message: CommitMessage) {
      return this.pass(JSON.stringify([message.subject, message.text]));
    }
  }

  // Act
  const [outcome] = await commitMsg({ root: top.path, environment, file }, [
    new Records(),
  ]);

  // Assert
  assert.equal(outcome?.kind, 'pass');
  assert.deepEqual(JSON.parse(outcome.message), [
    'feat: one',
    'feat: one\n\nThe body.\n',
  ]);
});
