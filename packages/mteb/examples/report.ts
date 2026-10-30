// Evaluates BM25 and BM25 with k1 1.2 and b 0.5 on the BM25 fixture (a folder
// dataset of 40 documents and 20 queries), writes the report of their results
// and prints the path of its page:
// nx run mteb:report
//
// The argument names the folder for the result cache, the predictions and
// the page; by default, a new folder in the temporary folder of the system.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AbsTaskRetrieval,
  type MTEBModels,
  ResultCache,
  TaskMetadata,
  bm25S,
  evaluate,
} from '../src/index.ts';
import { Report } from '../src/report/index.ts';

class Bm25Fixture extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'Bm25Fixture',
        description:
          'The BM25 fixture of @zukhruf/mteb: 20 queries on 40 documents.',
        dataset: {
          path: join(
            import.meta.dirname,
            '../src/models/model-implementations/fixtures/bm25',
          ),
          revision: '1',
        },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

const folder = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'mteb-report-'));
const task = new Bm25Fixture();
const baseline = bm25S.loadModel();
const models: MTEBModels[] = [baseline, bm25S.loadModel({ k1: 1.2, b: 0.5 })];
const cache = new ResultCache(folder);
const predictionFolder = (model: MTEBModels) =>
  join(
    folder,
    'predictions',
    `${model.mtebModelMeta.modelNameAsPath()}${model.mtebModelMeta.experimentName ?? ''}`,
  );
for (const model of models)
  await evaluate(model, task, {
    cache,
    predictionFolder: predictionFolder(model),
    overwriteStrategy: 'always',
  });

const report = await Report.from({
  task,
  models,
  cache,
  predictionFolder,
  baseline,
});
const page = join(folder, 'report.html');
writeFileSync(page, report.toHtml());
console.log(report.verdicts.toString());
console.log(page);
