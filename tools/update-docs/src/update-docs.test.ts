import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  ClaimRefused,
  CommitRefused,
  NoClaim,
  NotStamped,
  NothingToCommit,
  ProjectClaimed,
  ReportInvalid,
  StampMismatch,
  SubjectRefused,
} from './errors.ts';
import { UpdateDocs } from './update-docs.ts';

async function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function git(directory: string, args: readonly string[], date?: string) {
  const { status, stdout, stderr } = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
    {
      cwd: directory,
      encoding: 'utf8',
      env:
        date === undefined
          ? process.env
          : { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
  assert.equal(status, 0, stderr);
  return stdout.trim();
}

/** Commits the files at the date, and returns the commit's sha. */
async function commit(
  directory: string,
  files: Record<string, string>,
  subject: string,
  date: string,
) {
  await write(directory, files);
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', subject], date);
  return git(directory, ['rev-parse', 'HEAD']);
}

/** A workspace with the pool package under packages/, committed once. */
async function workspace(root: string) {
  git(root, ['init', '-q']);
  return commit(
    root,
    {
      'packages/pool/project.json': JSON.stringify({ name: 'pool' }),
      'packages/pool/package.json': JSON.stringify({ name: '@zukhruf/pool' }),
      'packages/pool/src/index.ts': 'export const pool = 1;\n',
    },
    'feat(pool): the first pool',
    '2026-01-01T00:00:00Z',
  );
}

/** Transcript lines in the shape Claude Code writes them. */
function session(cwd: string) {
  const sessionId = randomUUID();
  const common = (timestamp: string) => ({
    parentUuid: null,
    isSidechain: false,
    uuid: randomUUID(),
    timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '2.1.150',
    gitBranch: 'main',
  });
  return {
    mode: () =>
      JSON.stringify({
        type: 'permission-mode',
        permissionMode: 'auto',
        sessionId,
      }),
    prompt: (timestamp: string, content: string) =>
      JSON.stringify({
        ...common(timestamp),
        type: 'user',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: { role: 'user', content },
      }),
    notification: (timestamp: string, content: string) =>
      JSON.stringify({
        ...common(timestamp),
        type: 'user',
        origin: { kind: 'task-notification', producer: 'session-task' },
        promptSource: 'system',
        message: { role: 'user', content },
      }),
    toolUse: (timestamp: string, input: Record<string, string>) =>
      JSON.stringify({
        ...common(timestamp),
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }],
        },
      }),
    text: (timestamp: string, text: string) =>
      JSON.stringify({
        ...common(timestamp),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }),
    toolResult: (timestamp: string, content: string) =>
      JSON.stringify({
        ...common(timestamp),
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }],
        },
      }),
    attachment: (timestamp: string, content: string) =>
      JSON.stringify({
        ...common(timestamp),
        type: 'attachment',
        attachment: { type: 'file', filename: 'README.md', content },
      }),
  };
}

async function transcript(home: string, folder: string, lines: string[]) {
  const path = join('.claude', 'projects', folder, `${randomUUID()}.jsonl`);
  await write(home, { [path]: `${lines.join('\n')}\n` });
  return join(home, path);
}

function records(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line): Record<string, unknown> => JSON.parse(line));
}

/**
 * A workspace a docs commit can land in: the pool and lease packages, their
 * docs, and a committer identity in the repo's config.
 */
async function docsWorkspace(root: string) {
  await workspace(root);
  git(root, ['config', 'user.name', 't']);
  git(root, ['config', 'user.email', 't@example.com']);
  await commit(
    root,
    {
      'packages/lease/project.json': JSON.stringify({ name: 'lease' }),
      'packages/lease/package.json': JSON.stringify({ name: '@zukhruf/lease' }),
      'packages/pool/README.md': '# pool\n',
      'packages/pool/docs/old.md': '# old\n',
      'packages/pool/docs/copied-from-lease.md': '# Copied from lease\n',
      'docs/copied-code.md': '# Copied code\n',
      'CONTEXT-MAP.md': '# Context map\n',
    },
    'chore: docs workspace',
    '2026-01-02T00:00:00Z',
  );
}

function sha256(text: string): string {
  return hash('sha256', text);
}

function head(root: string): string {
  return git(root, ['rev-parse', 'HEAD']);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test('finish rejects a report with an empty title, names the field, and leaves the ledger as it was', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await workspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await write(home.path, {
    'good.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [],
      open: [
        { title: 'Document campaigns', target: 'packages/pool/README.md' },
      ],
    }),
    'bad.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [],
      open: [{ title: ' ', target: 'packages/pool/README.md' }],
    }),
  });
  await tool.run([
    'finish',
    'pool',
    '--started',
    '2026-06-01T00:00:00Z',
    '--report',
    join(home.path, 'good.json'),
  ]);
  const ledger = join(home.path, '.claude/plans/update-docs/ledger.json');
  const before = await readFile(ledger, 'utf8');

  // Act
  const rejected = tool.run([
    'finish',
    'pool',
    '--started',
    '2026-07-01T00:00:00Z',
    '--report',
    join(home.path, 'bad.json'),
  ]);

  // Assert
  await assert.rejects(
    rejected,
    (error) => error instanceof ReportInvalid && error.path === 'open[0].title',
  );
  assert.equal(await readFile(ledger, 'utf8'), before);
});

test('finish rejects a report with an unknown key and a wrong type, each by its field path', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await workspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await write(home.path, {
    'extra.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [{ title: 'x', target: 'y', reason: 'z', severity: 1 }],
      open: [],
    }),
    'type.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [],
      open: [{ title: 7, target: 'packages/pool/README.md' }],
    }),
  });
  const finish = (report: string) =>
    tool.run([
      'finish',
      'pool',
      '--started',
      '2026-06-01T00:00:00Z',
      '--report',
      join(home.path, report),
    ]);

  // Act
  const extra = await finish('extra.json').then(
    () => 'resolved',
    (error: unknown) => error,
  );
  const type = await finish('type.json').then(
    () => 'resolved',
    (error: unknown) => error,
  );

  // Assert
  assert.ok(extra instanceof ReportInvalid);
  assert.equal(extra.path, 'blocked[0].severity');
  assert.ok(type instanceof ReportInvalid);
  assert.equal(type.path, 'open[0].title');
  await assert.rejects(
    readFile(join(home.path, '.claude/plans/update-docs/ledger.json')),
    { code: 'ENOENT' },
  );
});

test('a transcript bundle keeps the prompt, tool input and assistant text that name the package, and drops echoes, task notifications and tool runs', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  const work = session(app.path);
  await transcript(home.path, '-work', [
    work.mode(),
    work.prompt('2026-03-01T10:00:00Z', 'why does @zukhruf/pool drop a job?'),
    work.toolUse('2026-03-01T10:00:01Z', {
      command: 'cat packages/pool/src/index.ts',
    }),
    work.toolResult(
      '2026-03-01T10:00:02Z',
      'export const pool = 1; // packages/pool/',
    ),
    work.attachment('2026-03-01T10:00:03Z', '# @zukhruf/pool'),
    work.notification(
      '2026-03-01T10:00:03Z',
      '<task-notification>\n<summary>tests of @zukhruf/pool passed</summary>\n</task-notification>',
    ),
    work.text('2026-03-01T10:00:04Z', 'The @zukhruf/pool owner settles jobs.'),
    work.prompt('2026-03-01T10:00:05Z', 'and the lease package?'),
  ]);
  const run = session(repo.path);
  await transcript(home.path, '-work', [
    run.prompt(
      '2026-03-02T10:00:00Z',
      '<command-message>update-docs</command-message>\n<command-name>/update-docs</command-name>\n<command-args>pool</command-args>',
    ),
    run.prompt('2026-03-02T10:00:01Z', 'update @zukhruf/pool docs'),
  ]);
  const hook = session(join(home.path, '.claude', 'hooks'));
  await transcript(home.path, '-hooks', [
    hook.prompt('2026-03-03T10:00:00Z', 'judge @zukhruf/pool'),
  ]);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  const found = records(stdout).filter(({ source }) => source === 'transcript');
  assert.deepEqual(
    found.map(({ kind, text }) => ({ kind, text })),
    [
      { kind: 'prompt', text: 'why does @zukhruf/pool drop a job?' },
      { kind: 'assistant-text', text: 'The @zukhruf/pool owner settles jobs.' },
      {
        kind: 'tool-input',
        text: JSON.stringify({ command: 'cat packages/pool/src/index.ts' }),
      },
    ],
  );
  assert.match(String(found[0]?.ref), /^-work\/[\da-f-]+\.jsonl:2$/);
  assert.equal(found[0]?.cwd, app.path);
});

test('--since drops the transcript lines and files older than the start', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await workspace(repo.path);
  const recent = session(repo.path);
  await transcript(home.path, '-work', [
    recent.prompt('2026-04-01T00:00:00Z', 'old: @zukhruf/pool'),
    recent.prompt('2026-06-01T00:00:00Z', 'new: @zukhruf/pool'),
  ]);
  const stale = session(repo.path);
  const staleFile = await transcript(home.path, '-work', [
    stale.prompt('2026-06-02T00:00:00Z', 'stale file: @zukhruf/pool'),
  ]);
  const old = new Date('2026-04-01T00:00:00Z');
  await utimes(staleFile, old, old);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run([
    'evidence',
    'pool',
    '--since',
    '2026-05-01T00:00:00Z',
  ]);

  // Assert
  assert.deepEqual(
    records(stdout)
      .filter(({ source }) => source === 'transcript')
      .map(({ text }) => text),
    ['new: @zukhruf/pool'],
  );
});

test('a repo a session ran in that declares the package gives its call sites; one that does not, or is excluded, gives none', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using consumer = await new TemporaryFiles().directory(
    'update-docs-app-',
  );
  await using bystander = await new TemporaryFiles().directory(
    'update-docs-other-',
  );
  await using excluded = await new TemporaryFiles().directory(
    'update-docs-off-',
  );
  await workspace(repo.path);
  for (const [root, manifest] of [
    [consumer.path, { dependencies: { '@zukhruf/pool': '*' } }],
    [bystander.path, { dependencies: { lodash: '*' } }],
    [excluded.path, { dependencies: { '@zukhruf/pool': '*' } }],
  ] as const) {
    git(root, ['init', '-q']);
    await commit(
      root,
      {
        'package.json': JSON.stringify(manifest),
        'src/jobs.ts': "import { Pool } from '@zukhruf/pool';\n",
      },
      'feat: jobs',
      '2026-02-01T00:00:00Z',
    );
  }
  for (const root of [
    consumer.path,
    bystander.path,
    join(excluded.path, 'src'),
  ]) {
    const elsewhere = session(root);
    await transcript(home.path, root.replaceAll('/', '-'), [
      elsewhere.prompt('2026-02-02T00:00:00Z', 'fix the build'),
    ]);
  }
  await write(home.path, {
    '.claude/plans/update-docs/config.json': JSON.stringify({
      exclude: [excluded.path],
    }),
  });
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  assert.deepEqual(
    records(stdout)
      .filter(({ source }) => source === 'consumer-site')
      .map(({ repo: found, ref, text }) => ({ repo: found, ref, text })),
    [
      {
        repo: consumer.path,
        ref: `${consumer.path}/src/jobs.ts:1`,
        text: "import { Pool } from '@zukhruf/pool';",
      },
    ],
  );
});

test('a package commit that changes only Markdown is no evidence, and one that changes code is', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  const first = await workspace(repo.path);
  await commit(
    repo.path,
    { 'packages/pool/README.md': '# pool\n' },
    'docs(pool): the readme',
    '2026-02-01T00:00:00Z',
  );
  const code = await commit(
    repo.path,
    {
      'packages/pool/src/index.ts': 'export const pool = 2;\n',
      'packages/pool/README.md': '# pool, 2\n',
    },
    'fix(pool): two',
    '2026-03-01T00:00:00Z',
  );
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  assert.deepEqual(
    records(stdout)
      .filter(({ source }) => source === 'package-commit')
      .map(({ ref, text }) => ({ ref, text })),
    [
      {
        ref: code,
        text: 'fix(pool): two\npackages/pool/README.md\npackages/pool/src/index.ts',
      },
      {
        ref: first,
        text: 'feat(pool): the first pool\npackages/pool/package.json\npackages/pool/project.json\npackages/pool/src/index.ts',
      },
    ],
  );
});

test("delta right after finish lists nothing for the project, though the run's docs commit and session name it", async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await workspace(repo.path);
  const docs = await commit(
    repo.path,
    { 'packages/pool/README.md': 'Use @zukhruf/pool for jobs.\n' },
    'docs(pool): campaigns',
    '2026-06-01T01:00:00Z',
  );
  const run = session(repo.path);
  await transcript(home.path, '-work', [
    run.prompt('2026-06-01T00:00:01Z', '/update-docs pool'),
    run.toolUse('2026-06-01T00:30:00Z', {
      command: 'node tools/update-docs/src/main.ts evidence pool',
    }),
    run.text('2026-06-01T00:40:00Z', 'Updated packages/pool/README.md.'),
  ]);
  await write(home.path, {
    'report.json': JSON.stringify({
      committed: [{ sha: docs, subject: 'docs(pool): campaigns' }],
      queued: [],
      blocked: [],
      open: [],
    }),
  });
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run([
    'finish',
    'pool',
    '--started',
    '2026-06-01T00:00:00Z',
    '--report',
    join(home.path, 'report.json'),
  ]);

  // Act
  const { stdout } = await tool.run(['delta']);

  // Assert
  assert.deepEqual(JSON.parse(stdout), { changed: [], neverRun: [] });
  assert.deepEqual(
    await readdir(join(home.path, '.claude/plans/update-docs/runs')),
    ['2026-06-01T00-00-00Z-pool.json'],
  );
});

test('delta counts a code commit made after the last run, and lists projects that never ran', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await workspace(repo.path);
  await commit(
    repo.path,
    {
      'packages/lease/project.json': JSON.stringify({ name: 'lease' }),
      'packages/lease/package.json': JSON.stringify({ name: '@zukhruf/lease' }),
    },
    'feat(lease): the first lease',
    '2026-01-02T00:00:00Z',
  );
  await write(home.path, {
    'report.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [],
      open: [],
    }),
  });
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run([
    'finish',
    'pool',
    '--started',
    '2026-06-01T00:00:00Z',
    '--report',
    join(home.path, 'report.json'),
  ]);
  await commit(
    repo.path,
    { 'packages/pool/src/index.ts': 'export const pool = 3;\n' },
    'fix(pool): three',
    '2026-07-01T00:00:00Z',
  );

  // Act
  const { stdout } = await tool.run(['delta']);

  // Assert
  assert.deepEqual(JSON.parse(stdout), {
    changed: [
      {
        project: 'pool',
        lastRun: '2026-06-01T00:00:00Z',
        counts: { packageCommit: 1, consumerCommit: 0, transcript: 0 },
      },
    ],
    neverRun: ['lease'],
  });
});

test('open exits 0 and prints each open item, and exits 1 when every item is blocked or there are none', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await workspace(repo.path);
  await write(home.path, {
    'open.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [],
      open: [
        { title: 'Document campaigns', target: 'packages/pool/README.md' },
      ],
    }),
    'blocked.json': JSON.stringify({
      committed: [],
      queued: [],
      blocked: [
        {
          title: 'Document campaigns',
          target: 'packages/pool/README.md',
          reason: 'needs Docker',
        },
      ],
      open: [],
    }),
  });
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  const finish = (report: string) =>
    tool.run([
      'finish',
      'pool',
      '--started',
      '2026-06-01T00:00:00Z',
      '--report',
      join(home.path, report),
    ]);

  // Act
  const none = await tool.run(['open']);
  await finish('open.json');
  const open = await tool.run(['open']);
  await finish('blocked.json');
  const blocked = await tool.run(['open']);

  // Assert
  assert.deepEqual(none, { exitCode: 1, stdout: '' });
  assert.deepEqual(open, {
    exitCode: 0,
    stdout: 'pool: Document campaigns (packages/pool/README.md)\n',
  });
  assert.deepEqual(blocked, { exitCode: 1, stdout: '' });
});

test('claim refuses a path a peer has edited or not committed, a non-Markdown path and a path outside the project, and records nothing', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  await write(repo.path, {
    'packages/pool/README.md': '# pool, a peer is editing\n',
    'packages/pool/docs/draft.md': '# a peer has not committed this\n',
  });
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  const claim = (path: string) =>
    tool.run(['claim', 'pool', path]).then(
      () => 'claimed',
      (error: unknown) => error,
    );

  // Act
  const refusals = [
    await claim('packages/pool/README.md'),
    await claim('packages/pool/docs/draft.md'),
    await claim('packages/pool/src/index.ts'),
    await claim('packages/lease/README.md'),
  ];

  // Assert
  assert.deepEqual(
    refusals.map((error) =>
      error instanceof ClaimRefused
        ? { path: error.path, refusal: error.refusal }
        : error,
    ),
    [
      { path: 'packages/pool/README.md', refusal: 'uncommitted' },
      { path: 'packages/pool/docs/draft.md', refusal: 'uncommitted' },
      { path: 'packages/pool/src/index.ts', refusal: 'not-markdown' },
      { path: 'packages/lease/README.md', refusal: 'outside-project' },
    ],
  );
  await assert.rejects(tool.run(['stamp', 'pool']), NoClaim);
});

test('claim refuses a copy ledger, at the root or in the project, since copy-check owns it', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  const claim = (path: string) =>
    tool.run(['claim', 'pool', path]).then(
      () => 'claimed',
      (error: unknown) => error,
    );

  // Act
  const refusals = [
    await claim('docs/copied-code.md'),
    await claim('packages/pool/docs/copied-from-lease.md'),
  ];

  // Assert
  assert.deepEqual(
    refusals.map((error) =>
      error instanceof ClaimRefused
        ? { path: error.path, refusal: error.refusal }
        : error,
    ),
    [
      { path: 'docs/copied-code.md', refusal: 'copy-ledger' },
      {
        path: 'packages/pool/docs/copied-from-lease.md',
        refusal: 'copy-ledger',
      },
    ],
  );
  await assert.rejects(tool.run(['stamp', 'pool']), NoClaim);
});

test('claim run as a command exits 2 with the reason on stderr', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);

  // Act
  const { status, stderr } = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'main.ts'), 'claim', 'pool', 'notes.txt'],
    {
      cwd: repo.path,
      encoding: 'utf8',
      env: { ...process.env, HOME: home.path },
    },
  );

  // Assert
  assert.equal(status, 2);
  assert.equal(stderr, 'Cannot claim notes.txt: it is not a .md file\n');
});

test("claim refuses the context map that another project's claim holds, and a second claim of one project", async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run(['claim', 'lease', 'CONTEXT-MAP.md']);

  // Act
  const shared = tool.run([
    'claim',
    'pool',
    'packages/pool/README.md',
    'CONTEXT-MAP.md',
  ]);
  await assert.rejects(
    shared,
    (error) =>
      error instanceof ClaimRefused &&
      error.refusal === 'claimed' &&
      error.path === 'CONTEXT-MAP.md',
  );
  await tool.run(['claim', 'pool', 'packages/pool/README.md']);
  const again = tool.run(['claim', 'pool', 'packages/pool/docs/old.md']);

  // Assert
  await assert.rejects(again, ProjectClaimed);
  assert.deepEqual(await tool.run(['stamp', 'pool']), {
    exitCode: 0,
    stdout: `packages/pool/README.md sha256:${sha256('# pool\n')}\n`,
  });
});

test('commit refuses when a claimed file changed after the stamp, commits nothing and leaves the shared index as it was', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run(['claim', 'pool', 'packages/pool/README.md']);
  await write(repo.path, { 'packages/pool/README.md': '# pool, drafted\n' });
  await tool.run(['stamp', 'pool']);
  await write(repo.path, {
    'packages/pool/README.md': '# pool, drafted\n\nA peer added this.\n',
    'packages/pool/src/index.ts': 'export const pool = 2;\n',
  });
  git(repo.path, ['add', 'packages/pool/src/index.ts']);
  const before = {
    head: head(repo.path),
    index: git(repo.path, ['ls-files', '-s']),
  };

  // Act
  const committed = tool.run(['commit', 'pool', '--subject', 'the readme']);

  // Assert
  await assert.rejects(
    committed,
    (error) =>
      error instanceof StampMismatch &&
      error.paths.join() === 'packages/pool/README.md',
  );
  assert.deepEqual(
    { head: head(repo.path), index: git(repo.path, ['ls-files', '-s']) },
    before,
  );
  await assert.rejects(
    tool.run(['commit', 'pool', '--subject', 'the readme']),
    StampMismatch,
  );
});

test("commit makes one docs commit of exactly the claimed paths that changed, keeps a peer's staged file staged and out of it, and leaves the claimed paths clean", async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run([
    'claim',
    'pool',
    'packages/pool/README.md',
    'packages/pool/docs/recipe.md',
    'packages/pool/docs/old.md',
    'CONTEXT-MAP.md',
  ]);
  const unwritten = await tool.run(['stamp', 'pool']);
  await write(repo.path, {
    'packages/pool/README.md': '# pool\n\nCampaigns.\n',
    'packages/pool/docs/recipe.md': '# Run a campaign\n',
  });
  await rm(join(repo.path, 'packages/pool/docs/old.md'));
  const written = await tool.run(['stamp', 'pool']);
  await write(repo.path, {
    'packages/pool/src/index.ts': 'export const pool = 2;\n',
  });
  git(repo.path, ['add', 'packages/pool/src/index.ts']);
  const base = head(repo.path);

  // Act
  const { stdout } = await tool.run([
    'commit',
    'pool',
    '--subject',
    'document campaigns',
    '--body',
    'Campaigns run jobs in waves.',
  ]);

  // Assert
  assert.equal(
    unwritten.stdout,
    [
      `packages/pool/README.md sha256:${sha256('# pool\n')}`,
      'packages/pool/docs/recipe.md absent',
      `packages/pool/docs/old.md sha256:${sha256('# old\n')}`,
      `CONTEXT-MAP.md sha256:${sha256('# Context map\n')}`,
      '',
    ].join('\n'),
  );
  assert.equal(
    written.stdout,
    [
      `packages/pool/README.md sha256:${sha256('# pool\n\nCampaigns.\n')}`,
      `packages/pool/docs/recipe.md sha256:${sha256('# Run a campaign\n')}`,
      'packages/pool/docs/old.md absent',
      `CONTEXT-MAP.md sha256:${sha256('# Context map\n')}`,
      '',
    ].join('\n'),
  );
  assert.equal(stdout, `${head(repo.path)}\n`);
  assert.equal(git(repo.path, ['rev-parse', 'HEAD^']), base);
  assert.equal(
    git(repo.path, ['log', '-1', '--format=%B']),
    'docs(pool): document campaigns\n\nCampaigns run jobs in waves.',
  );
  assert.equal(
    git(repo.path, ['show', '--name-status', '--format=', 'HEAD']),
    [
      'M\tpackages/pool/README.md',
      'D\tpackages/pool/docs/old.md',
      'A\tpackages/pool/docs/recipe.md',
    ].join('\n'),
  );
  assert.equal(
    git(repo.path, ['diff', '--cached', '--name-only']),
    'packages/pool/src/index.ts',
  );
  assert.equal(
    git(repo.path, [
      'status',
      '--porcelain',
      '--',
      'packages/pool/README.md',
      'packages/pool/docs',
      'CONTEXT-MAP.md',
    ]),
    '',
  );
  await assert.rejects(tool.run(['stamp', 'pool']), NoClaim);
});

test('a failing pre-commit hook stops the commit, leaves the shared index as it was and keeps the claim, and the hook reads the commit of the claimed paths alone', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run(['claim', 'pool', 'CONTEXT-MAP.md']);
  await write(repo.path, {
    'CONTEXT-MAP.md': '# Context map\n\n| pool | jobs |\n',
    'packages/pool/src/index.ts': 'export const pool = 2;\n',
  });
  git(repo.path, ['add', 'packages/pool/src/index.ts']);
  await tool.run(['stamp', 'pool']);
  const hook = join(repo.path, '.git/hooks/pre-commit');
  const seen = join(home.path, 'staged-in-hook.txt');
  await write(repo.path, {
    '.git/hooks/pre-commit': `#!/bin/sh\ngit diff --cached --name-only > '${seen}'\necho 'refused by the hook' >&2\nexit 1\n`,
  });
  await chmod(hook, 0o755);
  const before = {
    head: head(repo.path),
    index: git(repo.path, ['ls-files', '-s']),
  };

  // Act
  const refused = await tool
    .run(['commit', 'pool', '--subject', 'the pool row'])
    .then(
      () => 'committed',
      (error: unknown) => error,
    );
  const indexAfterRefusal = git(repo.path, ['ls-files', '-s']);
  await rm(hook);
  const { stdout } = await tool.run([
    'commit',
    'pool',
    '--subject',
    'the pool row',
  ]);

  // Assert
  assert.ok(refused instanceof CommitRefused);
  assert.match(refused.message, /refused by the hook/);
  assert.equal(indexAfterRefusal, before.index);
  assert.equal(await readFile(seen, 'utf8'), 'CONTEXT-MAP.md\n');
  assert.equal(git(repo.path, ['rev-parse', `${stdout.trim()}^`]), before.head);
  assert.equal(
    git(repo.path, ['log', '-1', '--format=%s', '--name-only']),
    'docs(pool): the pool row\n\nCONTEXT-MAP.md',
  );
  assert.equal(
    git(repo.path, ['diff', '--cached', '--name-only']),
    'packages/pool/src/index.ts',
  );
});

test('commit refuses with no stamp, a subject the commit-msg hook would refuse, and no changed path, and keeps the claim', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run(['claim', 'pool', 'packages/pool/README.md']);
  const before = head(repo.path);

  // Act
  const unstamped = tool.run(['commit', 'pool', '--subject', 'the readme']);
  await assert.rejects(unstamped, NotStamped);
  await tool.run(['stamp', 'pool']);
  const scoped = tool.run([
    'commit',
    'pool',
    '--subject',
    'campaigns (#3840): waves',
  ]);
  const unchanged = tool.run(['commit', 'pool', '--subject', 'the readme']);

  // Assert
  await assert.rejects(scoped, SubjectRefused);
  await assert.rejects(unchanged, NothingToCommit);
  assert.equal(head(repo.path), before);
  assert.equal((await tool.run(['stamp', 'pool'])).exitCode, 0);
});

test('release --revert puts a drafted file back and deletes a created one', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run([
    'claim',
    'pool',
    'packages/pool/README.md',
    'packages/pool/docs/recipe.md',
  ]);
  await write(repo.path, {
    'packages/pool/README.md': '# pool, a rejected draft\n',
    'packages/pool/docs/recipe.md': '# A rejected recipe\n',
  });
  await tool.run(['stamp', 'pool']);

  // Act
  await tool.run(['release', 'pool', '--revert']);

  // Assert
  assert.equal(
    await readFile(join(repo.path, 'packages/pool/README.md'), 'utf8'),
    '# pool\n',
  );
  assert.equal(
    await exists(join(repo.path, 'packages/pool/docs/recipe.md')),
    false,
  );
  assert.equal(git(repo.path, ['status', '--porcelain', '--', 'packages']), '');
  await assert.rejects(tool.run(['stamp', 'pool']), NoClaim);
});

test('release --revert refuses without a stamp and when a file changed after the stamp, and reverts nothing', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run([
    'claim',
    'pool',
    'packages/pool/README.md',
    'packages/pool/docs/recipe.md',
  ]);
  await write(repo.path, {
    'packages/pool/README.md': '# pool, a rejected draft\n',
    'packages/pool/docs/recipe.md': '# A rejected recipe\n',
  });
  const unstamped = tool.run(['release', 'pool', '--revert']);
  await assert.rejects(unstamped, NotStamped);
  await tool.run(['stamp', 'pool']);
  await write(repo.path, {
    'packages/pool/README.md': '# pool, a peer rewrote it\n',
  });

  // Act
  const reverted = tool.run(['release', 'pool', '--revert']);

  // Assert
  await assert.rejects(
    reverted,
    (error) =>
      error instanceof StampMismatch &&
      error.paths.join() === 'packages/pool/README.md',
  );
  assert.equal(
    await readFile(join(repo.path, 'packages/pool/README.md'), 'utf8'),
    '# pool, a peer rewrote it\n',
  );
  assert.equal(
    await readFile(join(repo.path, 'packages/pool/docs/recipe.md'), 'utf8'),
    '# A rejected recipe\n',
  );
});

test('release without --revert gives back the listed paths, or all of them, and leaves the files as they are', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await docsWorkspace(repo.path);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  await tool.run([
    'claim',
    'pool',
    'packages/pool/README.md',
    'packages/pool/docs/old.md',
  ]);
  await write(repo.path, { 'packages/pool/README.md': '# pool, kept\n' });

  // Act
  await tool.run(['release', 'pool', 'packages/pool/README.md']);
  const rest = await tool.run(['stamp', 'pool']);
  await tool.run(['release', 'pool']);

  // Assert
  assert.equal(
    rest.stdout,
    `packages/pool/docs/old.md sha256:${sha256('# old\n')}\n`,
  );
  await assert.rejects(tool.run(['stamp', 'pool']), NoClaim);
  assert.equal(
    await readFile(join(repo.path, 'packages/pool/README.md'), 'utf8'),
    '# pool, kept\n',
  );
});

test('a session in the workspace gives its prompts and assistant texts but no tool input, and a consumer session gives its tool input', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  const own = session(join(repo.path, 'packages', 'pool'));
  await transcript(home.path, '-work', [
    own.prompt('2026-03-01T10:00:00Z', 'make @zukhruf/pool settle jobs'),
    own.toolUse('2026-03-01T10:00:01Z', {
      command: 'cat packages/pool/src/index.ts',
    }),
    own.text('2026-03-01T10:00:02Z', 'The @zukhruf/pool owner settles jobs.'),
  ]);
  const root = session(repo.path);
  await transcript(home.path, '-work', [
    root.prompt('2026-03-01T11:00:00Z', 'release'),
    root.toolUse('2026-03-01T11:00:01Z', { command: 'npm view @zukhruf/pool' }),
  ]);
  const consumer = session(app.path);
  await transcript(home.path, '-app', [
    consumer.prompt('2026-03-02T10:00:00Z', 'fix the build'),
    consumer.toolUse('2026-03-02T10:00:01Z', {
      command: "grep -r '@zukhruf/pool' src",
    }),
  ]);
  // A folder whose name starts with the workspace's is not inside it.
  const sibling = `${repo.path}-app`;
  await mkdir(sibling);
  await using _sibling = {
    [Symbol.asyncDispose]: () => rm(sibling, { recursive: true, force: true }),
  };
  const beside = session(sibling);
  await transcript(home.path, '-beside', [
    beside.prompt('2026-03-03T10:00:00Z', 'fix the build'),
    beside.toolUse('2026-03-03T10:00:01Z', { command: 'ls @zukhruf/pool' }),
  ]);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  assert.deepEqual(
    records(stdout)
      .filter(({ source }) => source === 'transcript')
      .map(({ kind, text, cwd }) => ({ kind, text, cwd })),
    [
      {
        kind: 'prompt',
        text: 'make @zukhruf/pool settle jobs',
        cwd: join(repo.path, 'packages', 'pool'),
      },
      {
        kind: 'assistant-text',
        text: 'The @zukhruf/pool owner settles jobs.',
        cwd: join(repo.path, 'packages', 'pool'),
      },
      {
        kind: 'tool-input',
        text: JSON.stringify({ command: 'ls @zukhruf/pool' }),
        cwd: sibling,
      },
      {
        kind: 'tool-input',
        text: JSON.stringify({ command: "grep -r '@zukhruf/pool' src" }),
        cwd: app.path,
      },
    ],
  );
});

test('a line a resumed session copied from an earlier one is given once, by the earlier session', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  const first = session(app.path);
  const firstFile = await transcript(home.path, '-app', [
    first.prompt('2026-03-01T10:00:00Z', 'why does @zukhruf/pool drop a job?'),
    first.toolUse('2026-03-01T10:00:01Z', { command: 'cat @zukhruf/pool' }),
  ]);
  const resumed = session(app.path);
  await transcript(home.path, '-app', [
    resumed.prompt(
      '2026-03-01T10:00:00Z',
      'why does @zukhruf/pool drop a job?',
    ),
    resumed.toolUse('2026-03-01T10:00:01Z', { command: 'cat @zukhruf/pool' }),
    resumed.text('2026-03-02T10:00:00Z', 'cat @zukhruf/pool'),
  ]);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  const firstSession = firstFile.split('/').at(-1)?.replace('.jsonl', '');
  assert.deepEqual(
    records(stdout)
      .filter(({ source }) => source === 'transcript')
      .map(({ kind, session: id }) => ({ kind, first: id === firstSession })),
    [
      { kind: 'prompt', first: true },
      { kind: 'assistant-text', first: false },
      { kind: 'tool-input', first: true },
    ],
  );
});

test('a session gives at most 12 records, its prompts and then its newest others, and a tool input is cut at 800 characters', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  const long = (length: number) =>
    `@zukhruf/pool ${'x'.repeat(length - '@zukhruf/pool '.length)}`;
  const work = session(app.path);
  await transcript(home.path, '-app', [
    work.prompt('2026-03-01T10:00:00Z', long(1400)),
    ...Array.from({ length: 14 }, (_, index) =>
      work.toolUse(`2026-03-01T10:01:${String(index).padStart(2, '0')}Z`, {
        command: `step ${index} of @zukhruf/pool`,
      }),
    ),
    work.text('2026-03-01T10:02:00Z', long(1400)),
    work.toolUse('2026-03-01T10:03:00Z', { command: long(2000) }),
    work.prompt('2026-03-01T10:04:00Z', 'and @zukhruf/pool leases?'),
  ]);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  const found = records(stdout).filter(({ source }) => source === 'transcript');
  assert.deepEqual(
    found.map(({ kind, text }) => [kind, String(text).length]),
    [
      ['prompt', 'and @zukhruf/pool leases?'.length],
      ['prompt', 1400],
      ['assistant-text', 1400],
      ['tool-input', 801],
      ...Array.from({ length: 8 }, (_, index) => [
        'tool-input',
        JSON.stringify({ command: `step ${13 - index} of @zukhruf/pool` })
          .length,
      ]),
    ],
  );
});

test('a session gives the lines before its first /update-docs command and none from it on', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  const work = session(app.path);
  await transcript(home.path, '-app', [
    work.prompt('2026-03-01T10:00:00Z', 'why does @zukhruf/pool drop a job?'),
    work.text('2026-03-01T10:00:01Z', 'The @zukhruf/pool owner settles jobs.'),
    work.prompt('2026-03-01T10:00:02Z', '<command-name>/clear</command-name>'),
    work.prompt('2026-03-01T10:00:02.500Z', 'now @zukhruf/pool docs'),
    work.prompt(
      '2026-03-01T10:00:03Z',
      '<command-message>coding:update-docs</command-message>\n<command-name>/coding:update-docs</command-name>\n<command-args>pool @zukhruf/pool</command-args>',
    ),
    work.toolUse('2026-03-01T10:00:04Z', { command: 'cat @zukhruf/pool' }),
    work.prompt('2026-03-01T10:00:05Z', 'also @zukhruf/pool leases'),
  ]);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  assert.deepEqual(
    records(stdout)
      .filter(({ source }) => source === 'transcript')
      .map(({ text }) => text),
    [
      'now @zukhruf/pool docs',
      'why does @zukhruf/pool drop a job?',
      'The @zukhruf/pool owner settles jobs.',
    ],
  );
});

test("show prints a project's ledger entry or that it never ran, and finish replaces the queued candidates and adds the commits", async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  const first = await workspace(repo.path);
  const second = await commit(
    repo.path,
    { 'packages/pool/README.md': '# pool\n' },
    'docs(pool): the readme',
    '2026-02-01T00:00:00Z',
  );
  const report = (committed: unknown[], queued: unknown[]) =>
    JSON.stringify({ committed, queued, blocked: [], open: [] });
  await write(home.path, {
    'one.json': report(
      [{ sha: first, subject: 'feat(pool): the first pool' }],
      [
        {
          kind: 'adr',
          title: 'Why campaigns',
          evidence: ['-work/a.jsonl:2'],
          reason: 'an ADR needs a watched run',
        },
      ],
    ),
    'two.json': report(
      [{ sha: second, subject: 'docs(pool): the readme' }],
      [
        {
          kind: 'stale-claim',
          title: 'README says jobs never retry',
          evidence: [first],
          reason: 'needs docker',
        },
      ],
    ),
    'bad.json': report(
      [],
      [{ kind: 'docker-recipe', title: 't', evidence: [], reason: 'r' }],
    ),
  });
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });
  const finish = (file: string, started: string) =>
    tool.run([
      'finish',
      'pool',
      '--started',
      started,
      '--report',
      join(home.path, file),
    ]);

  // Act
  const never = await tool.run(['show', 'pool']);
  await finish('one.json', '2026-06-01T00:00:00Z');
  await finish('two.json', '2026-07-01T00:00:00Z');
  const shown = await tool.run(['show', 'pool']);
  const bad = finish('bad.json', '2026-08-01T00:00:00Z');

  // Assert
  await assert.rejects(
    bad,
    (error) =>
      error instanceof ReportInvalid && error.path === 'queued[0].kind',
  );
  assert.deepEqual(JSON.parse(never.stdout), { state: 'never-run' });
  assert.deepEqual(JSON.parse(shown.stdout), {
    lastRun: '2026-07-01T00:00:00Z',
    commits: [
      {
        sha: first,
        subject: 'feat(pool): the first pool',
        at: '2026-01-01T00:00:00Z',
      },
      {
        sha: second,
        subject: 'docs(pool): the readme',
        at: '2026-02-01T00:00:00Z',
      },
    ],
    queued: [
      {
        kind: 'stale-claim',
        title: 'README says jobs never retry',
        evidence: [first],
        reason: 'needs docker',
      },
    ],
    open: [],
    blocked: [],
  });
});

test('a bundle over 120,000 bytes keeps every prompt ahead of the package commits, and ends with an omitted record that counts what was cut', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  await commit(
    repo.path,
    Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `packages/pool/src/f${index + 1}.ts`,
        `export const f${index + 1} = 1;\n`,
      ]),
    ),
    'feat(pool): eight files',
    '2026-02-01T00:00:00Z',
  );
  const long = (label: string) =>
    `${label} @zukhruf/pool ${'x'.repeat(1490 - label.length - 15)}`;
  for (let day = 1; day <= 6; day++) {
    const work = session(app.path);
    await transcript(home.path, '-app', [
      ...Array.from({ length: 9 }, (_, index) =>
        work.prompt(
          `2026-03-0${day}T10:00:0${index}Z`,
          long(`prompt ${day}.${index}`),
        ),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        work.text(
          // The first session's last text is the newest of all, so it is the
          // newest session though its other texts are the oldest.
          day === 1 && index === 2
            ? '2026-03-07T11:00:00Z'
            : `2026-03-0${day}T11:00:0${index}Z`,
          long(`text ${day}.${index}`),
        ),
      ),
    ]);
  }
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  const lines = records(stdout);
  const kept = lines.slice(0, -1);
  const last = lines.at(-1);
  const tier = ({ source, kind }: Record<string, unknown>) =>
    source === 'transcript' ? `transcript:${String(kind)}` : String(source);
  const keptOf = (name: string) =>
    kept.filter((record) => tier(record) === name).length;
  const texts = keptOf('transcript:assistant-text');
  assert.ok(Buffer.byteLength(stdout) <= 120_000);
  assert.ok(Buffer.byteLength(stdout) > 120_000 - 2000);
  assert.deepEqual(kept.map(tier), [
    ...Array.from({ length: 54 }, () => 'transcript:prompt'),
    'package-commit',
    'package-commit',
    ...Array.from({ length: texts }, () => 'transcript:assistant-text'),
  ]);
  assert.deepEqual(
    kept
      .filter((record) => tier(record) === 'transcript:prompt')
      .map(({ text }) => String(text).split(' ')[1]),
    [6, 5, 4, 3, 2, 1].flatMap((day) =>
      [8, 7, 6, 5, 4, 3, 2, 1, 0].map((index) => `${day}.${index}`),
    ),
  );
  assert.ok(texts >= 4 && texts < 18);
  assert.deepEqual(
    kept
      .filter((record) => tier(record) === 'transcript:assistant-text')
      .map(({ text }) => String(text).split(' ')[1]),
    [1, 6, 5, 4, 3, 2]
      .flatMap((day) => [2, 1, 0].map((index) => `${day}.${index}`))
      .slice(0, texts),
  );
  assert.deepEqual(
    kept
      .filter(({ source }) => source === 'package-commit')
      .map(({ text }) => text),
    [
      [
        'feat(pool): eight files',
        ...Array.from(
          { length: 5 },
          (_, index) => `packages/pool/src/f${index + 1}.ts`,
        ),
        'and 3 more',
      ].join('\n'),
      'feat(pool): the first pool\npackages/pool/package.json\npackages/pool/project.json\npackages/pool/src/index.ts',
    ],
  );
  assert.equal(last?.source, 'omitted');
  const generated = {
    'transcript:prompt': 54,
    'consumer-commit': 0,
    'consumer-site': 0,
    'package-commit': 2,
    'transcript:assistant-text': 18,
    'transcript:tool-input': 0,
  };
  assert.deepEqual(
    last?.omitted,
    Object.fromEntries(
      Object.entries(generated).map(([name, count]) => [
        name,
        count - keptOf(name),
      ]),
    ),
  );
  assert.equal(
    last?.oldestKept,
    kept
      .map(({ ts }) => String(ts))
      .toSorted((a, b) =>
        Temporal.Instant.compare(
          Temporal.Instant.from(a),
          Temporal.Instant.from(b),
        ),
      )[0],
  );
});

test('a bundle under 120,000 bytes has every record and no omitted record', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  const work = session(app.path);
  await transcript(home.path, '-app', [
    work.prompt('2026-03-01T10:00:00Z', 'why does @zukhruf/pool drop a job?'),
  ]);
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  assert.deepEqual(
    records(stdout).map(({ source }) => source),
    ['transcript', 'package-commit'],
  );
});

test('the omitted record counts toward the 120,000 bytes, so a bundle cut among small records still fits', async () => {
  // Arrange
  await using home = await new TemporaryFiles().directory('update-docs-home-');
  await using repo = await new TemporaryFiles().directory('update-docs-repo-');
  await using app = await new TemporaryFiles().directory('update-docs-app-');
  await workspace(repo.path);
  // 200 small code commits in one process: each package-commit line is
  // shorter than the omitted line, so the cut leaves less room than it needs.
  const branch = git(repo.path, ['symbolic-ref', 'HEAD']);
  const stream = Array.from({ length: 200 }, (_, index) => {
    const message = `fix(pool): c${index}`;
    const content = `export const c${index} = 1;\n`;
    return [
      `commit ${branch}`,
      `committer t <t@example.com> ${1_770_000_000 + index * 60} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
      ...(index === 0 ? [`from ${branch}^0`] : []),
      `M 100644 inline packages/pool/src/c${index}.ts`,
      `data ${Buffer.byteLength(content)}`,
      content,
    ].join('\n');
  }).join('\n');
  const imported = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: repo.path,
    input: `${stream}\n`,
    encoding: 'utf8',
  });
  assert.equal(imported.status, 0, imported.stderr);
  const long = (label: string) =>
    `${label} @zukhruf/pool ${'x'.repeat(1490 - label.length - 15)}`;
  for (let day = 1; day <= 6; day++) {
    const work = session(app.path);
    await transcript(
      home.path,
      '-app',
      Array.from({ length: 9 }, (_, index) =>
        work.prompt(
          `2026-03-0${day}T10:00:0${index}Z`,
          long(`prompt ${day}.${index}`),
        ),
      ),
    );
  }
  const tool = new UpdateDocs({
    home: home.path,
    repoRoot: repo.path,
    variables: process.env,
  });

  // Act
  const { stdout } = await tool.run(['evidence', 'pool']);

  // Assert
  const lines = records(stdout);
  const last = lines.at(-1);
  const kept = lines.filter(({ source }) => source === 'package-commit').length;
  assert.ok(Buffer.byteLength(stdout) <= 120_000);
  assert.equal(last?.source, 'omitted');
  assert.deepEqual(last?.omitted, {
    'transcript:prompt': 0,
    'consumer-commit': 0,
    'consumer-site': 0,
    'package-commit': 201 - kept,
    'transcript:assistant-text': 0,
    'transcript:tool-input': 0,
  });
});
