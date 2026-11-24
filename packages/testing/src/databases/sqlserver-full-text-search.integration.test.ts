import assert from 'node:assert/strict';
import { hash, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { BuildFailedError, Docker } from '@zukhruf/docker';

import { waitFor } from '../async/wait-for.ts';
import { DockerTestbed } from '../docker/testbed.ts';
import { test } from '../node/index.ts';
import { SqlServer } from './sqlserver.ts';

// SQL Server 2025 crashes at start about once in 41 starts when an arm64
// engine emulates amd64 (lsass, errno 11; #5469), and 2022 does not, so the
// 2025 claims run only where the engine runs amd64 natively, as on CI.
const emulation = await SqlServer.emulation({ environment: process.env });

const servers = [
  {
    name: 'SQL Server 2022',
    image: 'mcr.microsoft.com/mssql/server:2022-latest',
    skip: false,
  },
  {
    name: 'SQL Server 2025',
    image: 'mcr.microsoft.com/mssql/server:2025-latest',
    skip: emulation,
  },
] as const;

/** The version of the server of a Microsoft image, from its label. */
async function labelledVersion(image: string): Promise<string | undefined> {
  await using docker = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  return (await docker.images.inspect(image))?.Config?.Labels?.[
    'com.microsoft.version'
  ];
}

void test.each(servers, ({ name, image, skip }) =>
  test(
    `${name} with fullTextSearch has the full-text component and runs the server of its base image`,
    { skip },
    async () => {
      // Arrange
      const sqlServer = new SqlServer({
        environment: process.env,
        image,
        fullTextSearch: true,
      });

      // Act
      await using database = await sqlServer.start();
      const pool = await database.pool();
      const { recordset } = await pool
        .request()
        .query<{ installed: number; version: string }>(
          "SELECT FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') AS installed, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(32)) AS version",
        );

      // Assert
      assert.deepEqual(recordset[0], {
        installed: 1,
        version: await labelledVersion(image),
      });
    },
  ),
);

void test.each(servers, ({ name, image, skip }) =>
  test(
    `${name} with fullTextSearch answers CONTAINSTABLE over a full-text index with the matching keys and their rank`,
    { skip },
    async (t) => {
      // Arrange
      await using database = await new SqlServer({
        environment: process.env,
        image,
        fullTextSearch: true,
      }).start();
      const pool = await database.pool();
      await pool.request().batch(`
      CREATE TABLE passage (id int NOT NULL CONSTRAINT pk_passage PRIMARY KEY, body nvarchar(200) NOT NULL);
      INSERT INTO passage VALUES
        (1, N'The quick brown fox jumps over the dog'),
        (2, N'A passage about retrieval'),
        (3, N'The lease ends when the holder exits');
      CREATE FULLTEXT CATALOG passage_catalog AS DEFAULT;
      CREATE FULLTEXT INDEX ON passage (body LANGUAGE 1033) KEY INDEX pk_passage WITH CHANGE_TRACKING AUTO;
    `);
      await waitFor(
        async () => {
          const { recordset } = await pool.request().query<{
            status: number;
            items: number;
          }>("SELECT OBJECTPROPERTYEX(OBJECT_ID('passage'), 'TableFulltextPopulateStatus') AS status, OBJECTPROPERTYEX(OBJECT_ID('passage'), 'TableFulltextItemCount') AS items");
          assert.deepEqual(recordset[0], { status: 0, items: 3 });
        },
        { signal: t.signal },
      );

      // Act
      const { recordset } = await pool
        .request()
        .query<{ id: number; rank: number }>(
          `SELECT [KEY] AS id, RANK AS rank FROM CONTAINSTABLE(passage, body, N'"passage" OR "lease"') ORDER BY [KEY]`,
        );

      // Assert
      assert.deepEqual(
        recordset.map(({ id }) => id),
        [2, 3],
      );
      assert.ok(
        recordset.every(({ rank }) => rank > 0),
        `Each match has a rank: ${JSON.stringify(recordset)}`,
      );
    },
  ),
);

test(
  'SQL Server 2025 with fullTextSearch keeps VECTOR and VECTOR_DISTANCE on the same server',
  { skip: emulation },
  async () => {
    // Arrange
    await using database = await new SqlServer({
      environment: process.env,
      image: 'mcr.microsoft.com/mssql/server:2025-latest',
      fullTextSearch: true,
    }).start();
    const pool = await database.pool();
    await pool.request().batch(`
    CREATE TABLE embedding (id int NOT NULL PRIMARY KEY, vector VECTOR(3) NOT NULL);
    INSERT INTO embedding VALUES (1, '[0, 1, 0]'), (2, '[1, 0, 0]'), (3, '[0.7, 0.7, 0]');
  `);

    // Act
    const { recordset } = await pool
      .request()
      .query<{ id: number }>(
        "SELECT id FROM embedding ORDER BY VECTOR_DISTANCE('cosine', vector, CAST('[1, 0, 0]' AS VECTOR(3)))",
      );
    const installed = await pool
      .request()
      .query<{ installed: number }>(
        "SELECT FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') AS installed",
      );

    // Assert
    assert.deepEqual(
      recordset.map(({ id }) => id),
      [2, 3, 1],
    );
    assert.deepEqual(installed.recordset, [{ installed: 1 }]);
  },
);

test('a second start with fullTextSearch runs the image that the first one built, and builds none', async (t) => {
  // Arrange
  const base = 'mcr.microsoft.com/mssql/server:2022-latest';
  const options = {
    environment: process.env,
    image: base,
    fullTextSearch: true,
  };
  await using docker = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  await docker.images.pull('busybox:1.37.0');
  await (await new SqlServer(options).start()).cleanup();
  // A build tags its image, also when it gives the same image ID again. The
  // engine keeps only its last 256 events, and the clock of `since` is the
  // engine's, so the record replays the whole buffer (`since` 1 s after the
  // epoch) and starts at the tag of a first sentinel, and the stream is live
  // up to the tag of a second one.
  const sentinel = () => `zukhruf-testing-fts-sentinel:${randomUUID()}`;
  const tag = async (name: string) => {
    await docker.images.tag('busybox:1.37.0', name);
    await docker.images.remove(name);
  };
  const first = sentinel();
  await tag(first);
  const tagEvents = docker.events({
    since: 1,
    filters: { type: ['image'], event: ['tag'] },
    signal: t.signal,
  });
  const events = tagEvents[Symbol.asyncIterator]();
  const namesUntil = async (end: string) => {
    const names: string[] = [];
    for (;;) {
      const { done, value } = await events.next();
      const name = done ? end : value.Actor?.Attributes?.name;
      if (name === end) return names;
      if (name !== undefined) names.push(name);
    }
  };
  await namesUntil(first);

  // Act
  let image: string;
  {
    await using second = await new SqlServer(options).start();
    image = second.image;
  }

  // Assert: a build in the record window shows in the record.
  const control = `zukhruf-testing-fts-control:${randomUUID()}`;
  try {
    await docker.images.build(
      { files: [{ path: 'Dockerfile', data: 'FROM busybox:1.37.0\n' }] },
      { t: control },
    );
    const last = sentinel();
    await tag(last);
    assert.deepEqual(
      (await namesUntil(last)).filter(
        (name) => name === image || name === control,
      ),
      [control],
    );
  } finally {
    await docker.images.remove(control);
  }
  const dockerfile = await readFile(
    new URL('sqlserver-full-text-search.Dockerfile', import.meta.url),
    'utf8',
  );
  assert.equal(
    image,
    `zukhruf-testing-sqlserver-fts:${await labelledVersion(base)}-${hash('sha256', dockerfile).slice(0, 12)}`,
  );
});

test('a base image whose server version has no mssql-server-fts package rejects with the BuildFailedError of the install step', async () => {
  // Arrange: a base that is SQL Server 2022 with the label of a version that Microsoft never shipped.
  await using docker = await Docker.connect({
    clock: globalThis,
    environment: process.env,
  });
  const base = `zukhruf-testing-fts-base:${randomUUID()}`;
  await docker.images.pull('mcr.microsoft.com/mssql/server:2022-latest');
  await docker.images.build(
    {
      files: [
        {
          path: 'Dockerfile',
          data: 'FROM mcr.microsoft.com/mssql/server:2022-latest\nLABEL com.microsoft.version=16.0.1.1\n',
        },
      ],
    },
    { t: base, platform: 'linux/amd64' },
  );
  try {
    // Act
    const acquisition = new SqlServer({
      environment: process.env,
      image: base,
      fullTextSearch: true,
    }).start();

    // Assert
    await assert.rejects(acquisition, (error: unknown) => {
      assert.ok(error instanceof BuildFailedError, String(error));
      assert.match(error.vertex ?? '', /RUN set -eux/);
      assert.match(
        error.output,
        /E: Version '16\.0\.1\.1-\*' for 'mssql-server-fts' was not found/,
      );
      return true;
    });
  } finally {
    await docker.images.remove(base);
  }
});

test('a base whose tag moved in its registry since the engine pulled it gives the tag of the moved server, and the built image holds that server', async (t) => {
  // Arrange: a registry whose tag holds the label of 16.0.4305.5, and an
  // engine that holds the same tag at 16.0.4295.3, as after a pull before the
  // tag moved. Both are real versions of mssql-server-fts, so a build of
  // either label succeeds.
  const testbed = new DockerTestbed({ environment: process.env });
  const docker = await testbed.client();
  const scope = `zukhruf-testing-fts-moved=${randomUUID()}`;
  try {
    // The registry listens in the network of the engine's host, where the
    // engine pulls and pushes: a published port of Docker Desktop answers on
    // the Mac, not where the engine runs. 127.0.0.1 is an insecure registry
    // by default, so it needs no TLS.
    const port = 49152 + randomInt(16384);
    await using _registry = await testbed.start({
      Image: 'registry:2',
      Env: [`REGISTRY_HTTP_ADDR=127.0.0.1:${port}`],
      HostConfig: { NetworkMode: 'host' },
    });
    const base = `127.0.0.1:${port}/zukhruf-testing-fts-base:moving`;
    const labelled = (version: string, tag: string) =>
      docker.images.build(
        {
          files: [
            {
              path: 'Dockerfile',
              data: `FROM mcr.microsoft.com/mssql/server:2022-latest\nLABEL com.microsoft.version=${version} ${scope}\n`,
            },
          ],
        },
        { t: tag, platform: 'linux/amd64' },
      );
    await docker.images.pull('mcr.microsoft.com/mssql/server:2022-latest', {
      platform: 'linux/amd64',
    });
    await labelled('16.0.4305.5', base);
    // The registry runs with no authentication and ignores the credentials.
    const auth = { username: 'zukhruf', password: 'zukhruf' };
    await waitFor(() => docker.images.push(base, { auth }), {
      signal: t.signal,
      interval: 250,
    });
    await labelled('16.0.4295.3', base);

    // Act
    let image: string;
    {
      await using database = await new SqlServer({
        environment: process.env,
        image: base,
        fullTextSearch: true,
      }).start();
      image = database.image;
    }

    // Assert
    const dockerfile = await readFile(
      new URL('sqlserver-full-text-search.Dockerfile', import.meta.url),
      'utf8',
    );
    assert.deepEqual(
      {
        image,
        label: (await docker.images.inspect(image))?.Config?.Labels?.[
          'com.microsoft.version'
        ],
      },
      {
        image: `zukhruf-testing-sqlserver-fts:16.0.4305.5-${hash('sha256', dockerfile).slice(0, 12)}`,
        label: '16.0.4305.5',
      },
    );
  } finally {
    // The two bases, and each image built from them, carry the scope label.
    const images = await docker.images.list({
      filters: { label: [scope] },
    });
    for (const { Id } of images)
      await docker.images.remove(Id, { force: true });
  }
});
