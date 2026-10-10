import { SqliteElection } from '@zukhruf/election';

/**
 * The election of the socket stores that share `directory`. Every published
 * version claims `leader.lock` and counts terms in `leader.epoch`
 * (wire-compatibility.test.ts pins both), so stores of two versions elect one
 * leader between them.
 */
export function socketElection(
  directory: string,
  pollInterval: number,
): SqliteElection {
  return new SqliteElection({
    directory,
    claimFile: 'leader.lock',
    epochFile: 'leader.epoch',
    pollInterval,
  });
}
