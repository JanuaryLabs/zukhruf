import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

/**
 * A consumer imports the package by its name, so this test does too: a child
 * process resolves each path through the exports of package.json, the way an
 * installed copy resolves it.
 */
const run = async (source: string): Promise<unknown> => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ]);
  return JSON.parse(stdout);
};

test('a consumer imports each subpath by its package name, and the package depends at run time only on ai, pgvector, @zukhruf/async, @zukhruf/statistics and @zukhruf/vectors', async () => {
  // Act
  const result = await run(`
    const core = await import('@zukhruf/retrieval');
    const { ModelMismatchError, PassageGapError, VectorMissingError } = core;
    const { SqliteBM25Retriever, SqliteEmbeddingRetriever, SqlitePassageStore } = await import('@zukhruf/retrieval/sqlite');
    const { PgvectorEmbeddingRetriever, PgvectorKeywordRetriever, PostgresPassageStore } = await import('@zukhruf/retrieval/postgres');
    const { SqlServerEmbeddingRetriever, SqlServerKeywordRetriever, SqlServerPassageStore } = await import('@zukhruf/retrieval/sqlserver');
    const { default: manifest } = await import('@zukhruf/retrieval/package.json', { with: { type: 'json' } });
    console.log(JSON.stringify({
      modelMismatch: new ModelMismatchError(
        { provider: 'openai', modelId: 'a' },
        { provider: 'openai', modelId: 'b' },
      ).name,
      vectorMissing: new VectorMissingError('p').name,
      passageGap: new PassageGapError('s', 1, 2).name,
      retrievers: [core.FusionRetriever, core.HydeRetriever, core.MultiQueryRetriever].map((type) => type.name),
      fusions: [core.distributionBasedScoreFusion, core.reciprocalRankFusion, core.relativeScoreFusion].map((fusion) => typeof fusion().fuse),
      postprocessors: [core.Collapse, core.ContextWindow, core.LongContextReorder, core.MaximalMarginalRelevance, core.PostprocessingRetriever, core.Rerank].map((type) => type.name),
      sqlite: [SqliteBM25Retriever, SqliteEmbeddingRetriever, SqlitePassageStore].map((type) => type.name),
      postgres: [PgvectorEmbeddingRetriever, PgvectorKeywordRetriever, PostgresPassageStore].map((type) => type.name),
      sqlserver: [SqlServerEmbeddingRetriever, SqlServerKeywordRetriever, SqlServerPassageStore].map((type) => type.name),
      postgresConditions: Object.keys(manifest.exports['./postgres']),
      sqlserverConditions: Object.keys(manifest.exports['./sqlserver']),
      dependencies: Object.keys(manifest.dependencies ?? {}),
    }));
  `);

  // Assert
  assert.deepEqual(result, {
    modelMismatch: 'ModelMismatchError',
    vectorMissing: 'VectorMissingError',
    passageGap: 'PassageGapError',
    retrievers: ['FusionRetriever', 'HydeRetriever', 'MultiQueryRetriever'],
    fusions: ['function', 'function', 'function'],
    postprocessors: [
      'Collapse',
      'ContextWindow',
      'LongContextReorder',
      'MaximalMarginalRelevance',
      'PostprocessingRetriever',
      'Rerank',
    ],
    sqlite: [
      'SqliteBM25Retriever',
      'SqliteEmbeddingRetriever',
      'SqlitePassageStore',
    ],
    postgres: [
      'PgvectorEmbeddingRetriever',
      'PgvectorKeywordRetriever',
      'PostgresPassageStore',
    ],
    sqlserver: [
      'SqlServerEmbeddingRetriever',
      'SqlServerKeywordRetriever',
      'SqlServerPassageStore',
    ],
    postgresConditions: ['@zukhruf/source', 'types', 'import', 'default'],
    sqlserverConditions: ['@zukhruf/source', 'types', 'import', 'default'],
    dependencies: [
      '@zukhruf/async',
      '@zukhruf/statistics',
      '@zukhruf/vectors',
      'ai',
      'pgvector',
    ],
  });
});

test('the built package imports only node built-ins, its dependencies and its own files at run time', async () => {
  // Arrange
  const dist = join(import.meta.dirname, '..', 'dist');
  const files = (await readdir(dist, { recursive: true })).filter((file) =>
    file.endsWith('.js'),
  );

  // Act
  const specifiers = new Set<string>();
  for (const file of files) {
    const source = await readFile(join(dist, file), 'utf8');
    for (const match of source.matchAll(
      /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    ))
      specifiers.add(match[1] ?? '');
  }

  // Assert
  assert.ok(
    specifiers.has('./model-mismatch-error.js'),
    'the scan found no imports',
  );
  assert.deepEqual(
    [...specifiers]
      .filter(
        (specifier) =>
          !specifier.startsWith('node:') && !specifier.startsWith('.'),
      )
      .toSorted(),
    [
      '@zukhruf/async',
      '@zukhruf/statistics',
      '@zukhruf/vectors',
      '@zukhruf/vectors/sqlite',
      '@zukhruf/vectors/sqlserver',
      'ai',
      'pgvector',
    ],
  );
});
