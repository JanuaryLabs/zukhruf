import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  type CampaignOptions,
  LeaderElection,
} from '../../leader-election/leader-election.ts';
import type { Leadership } from '../../leader-election/leadership.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { ElectingConnector } from './electing-connector.ts';

describe('Electing connector', () => {
  test('a connect aborted while it campaigns resigns the term it wins and never serves', async () => {
    // Arrange: nobody serves the directory, and the abort lands while the campaign wins.
    await using directory = await scratchDirectory();
    const election = new LeaderElection(directory.path, { pollInterval: 10 });
    const abort = new AbortController();
    const served: Leadership[] = [];
    const connector = new ElectingConnector({
      socketPath: join(directory.path, 'lock.sock'),
      election: {
        campaign: async (options?: CampaignOptions) => {
          const won = await election.campaign(options);
          abort.abort();
          return won;
        },
      },
      pollInterval: 10,
      serve: async (leadership) => {
        served.push(leadership);
      },
      connected: () => {},
    });

    // Act
    const connecting = connector.connect(abort.signal);

    // Assert
    await assert.rejects(connecting, { name: 'AbortError' });
    assert.deepEqual(served, [], 'An aborted connect must not start serving');
    await using next = await new LeaderElection(directory.path, {
      pollInterval: 10,
    }).campaign();
    assert.ok(next, 'An aborted connect must resign the term it won');
  });

  test('a connect aborted before it starts never campaigns', async () => {
    // Arrange
    await using directory = await scratchDirectory();
    let campaigns = 0;
    const connector = new ElectingConnector({
      socketPath: join(directory.path, 'lock.sock'),
      election: {
        campaign: async () => {
          campaigns++;
          return undefined;
        },
      },
      pollInterval: 10,
      serve: async () => {},
      connected: () => {},
    });

    // Act
    const connecting = connector.connect(AbortSignal.abort());

    // Assert
    await assert.rejects(connecting, { name: 'AbortError' });
    assert.equal(campaigns, 0, 'An aborted connect must not campaign');
  });
});
