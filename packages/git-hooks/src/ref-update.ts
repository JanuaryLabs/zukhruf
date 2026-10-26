// One line that git gives the pre-push hook on its standard input
// (githooks(5)): `<local ref> SP <local sha> SP <remote ref> SP <remote sha>`.
interface RefLine {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

// A create or an update sends the commits from `base` (the newest commit that
// the remote has) to `head` (the local commit). With no `base`, the remote has
// no commit of that history. With `base` equal to `head`, the range is empty.
export type RefUpdate =
  | (RefLine & {
      readonly kind: 'create' | 'update';
      readonly head: string;
      readonly base: string | undefined;
    })
  | (RefLine & { readonly kind: 'delete' });

type Git = (...args: string[]) => Promise<string>;

const absent = /^0+$/;

export async function readRefUpdates(
  git: Git,
  remote: string,
  input: string,
): Promise<RefUpdate[]> {
  const updates: RefUpdate[] = [];
  for (const line of input.split('\n')) {
    if (line.trim() === '') continue;
    const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = line
      .trim()
      .split(' ');
    const refLine = { localRef, localSha, remoteRef, remoteSha };
    if (absent.test(localSha)) {
      updates.push({ ...refLine, kind: 'delete' });
      continue;
    }
    const kind = absent.test(remoteSha) ? 'create' : 'update';
    const base =
      kind === 'update' && (await isLocal(git, remoteSha))
        ? remoteSha
        : await firstUnseenParent(git, remote, localSha);
    updates.push({ ...refLine, kind, head: localSha, base });
  }
  return updates;
}

async function isLocal(git: Git, sha: string): Promise<boolean> {
  try {
    await git('cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

// The parent of the first commit that no ref of the remote has, as the
// pre-commit framework finds the "from" ref of its pre-push stage.
async function firstUnseenParent(
  git: Git,
  remote: string,
  head: string,
): Promise<string | undefined> {
  const unseen = await git(
    'rev-list',
    head,
    '--topo-order',
    '--reverse',
    '--not',
    `--remotes=${remote}`,
  );
  const [first = ''] = unseen.split('\n', 1);
  if (first === '') return head;
  const parents = await git('rev-list', '--parents', '--max-count=1', first);
  const [, parent] = parents.trim().split(' ');
  return parent;
}
