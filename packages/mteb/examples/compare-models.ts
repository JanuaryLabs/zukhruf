// Compares EmbeddingGemma 2 and Qwen3-Embedding-0.6B on MTEB's tasks ArguAna
// and SCIDOCS: nx run mteb:compare
//
// Two llama.cpp servers serve the Q8_0 weights of the models:
//
//   llama-server -m embeddinggemma-2-Q8_0.gguf --port 8110 \
//     -c 8192 -b 8192 -ub 8192 --embedding
//   llama-server -m Qwen3-Embedding-0.6B-Q8_0.gguf --port 8111 \
//     -c 8192 -b 8192 -ub 8192 --embedding --pooling last
//
// The quantization is an experiment argument, so these results stay apart
// from the results of the full weights. The results and the downloaded files
// stay in ~/.cache/mteb, so a second run loads the results of the first.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  ArguAna,
  ResultCache,
  SCIDOCS,
  embeddingGemma2,
  evaluate,
  qwen3Embedding0B6,
} from '../src/index.ts';

const models = [
  {
    baseURL: 'http://127.0.0.1:8110/v1',
    meta: embeddingGemma2,
    id: 'google/embeddinggemma-2',
  },
  {
    baseURL: 'http://127.0.0.1:8111/v1',
    meta: qwen3Embedding0B6,
    id: 'Qwen/Qwen3-Embedding-0.6B',
  },
];
const cache = new ResultCache();
console.log('Model                        Task      nDCG@10  Seconds');
for (const { baseURL, meta, id } of models) {
  const provider = createOpenAICompatible({ name: 'llama.cpp', baseURL });
  const encoder = meta.loadModel({
    model: provider.embeddingModel(id),
    quantization: 'Q8_0',
  });
  const result = await evaluate(encoder, [new ArguAna(), new SCIDOCS()], {
    cache,
  });
  for (const task of result.taskResults)
    console.log(
      `${id.padEnd(28)} ${task.taskName.padEnd(9)} ${task.mainScore.toFixed(4).padStart(7)} ${(task.evaluationTime ?? 0).toFixed(0).padStart(8)}`,
    );
  for (const { taskName, exception } of result.exceptions ?? [])
    console.log(`${id.padEnd(28)} ${taskName.padEnd(9)} failed: ${exception}`);
}
