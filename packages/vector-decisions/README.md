# @zukhruf/vector-decisions

> **Status: in progress.** Units 0 to 4, 5a and 5b of 17 are done: the package downloads the venn-1 head, checks it, reads its weights, gives the logits of a question for state vectors, makes those vectors from text through a reader with Venn's prompt and cache, and answers Choice, Score and Noul questions about one state, and IndexApply questions about each row of a plural state, with `DecisionService`, which also prepares a question for many decisions. The decisions are in [ADR 0001](docs/adr/0001-port-the-library-core-of-venn-at-one-commit-one-unit-at-a-time.md).

A program often needs a decision about a text, not new text: which team owns a ticket, how urgent it is, or if it is a defect. A decision model such as Jev reads the text again for each question. This package answers the same typed questions from vectors. A reader embeds each text one time. Then a small head compares the vector of the text with the vectors of the options. This package is a TypeScript port of the library core of [Venn](https://github.com/markrussinovich/venn-vdm) (commit `7b2042e`).

The package is private: a workspace reaches it through its path. The words are defined in [CONTEXT.md](CONTEXT.md).

## Units

Each unit works and has tests alone, and it composes with the units before it.

| Unit | What it does                                                                                 | Venn source                                        | State   |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| U0   | The package                                                                                  | -                                                  | done    |
| U1   | Reads the tensors of a `.safetensors` file                                                   | `runtime.load_weights`                             | done    |
| U2   | Downloads the files of a model at one revision and checks their SHA-256                      | `runtime.model_directory`                          | done    |
| U3   | The head: the option logits and the "none" logit of a state                                  | `heads/abstention.py`, `index/*.py`                | done    |
| U4   | The reader: the Classification prefix and the vector cache, around an AI SDK embedding model | `reader.py`, `server.py`                           | done    |
| U5a  | `DecisionService.decide` for one state: Choice, Score and Noul                               | `server.py`                                        | done    |
| U5b  | IndexApply and prepared questions (`registerQuestion`, `question_ref`)                       | `server.py`                                        | done    |
| U6   | An AI SDK decision model over a `DecisionService` (addition: Venn has an HTTP route)         | `decisions.py`                                     | planned |
| U7   | Calibration: the temperature fit, on an optimizer that moves out of mteb                     | `heads/calibration.py`                             | planned |
| U8   | Registered indexes and `streamIndex`, NearestReference, SetMembership and PopulationShift    | `server.py`, `index/decision.py`, `index/shift.py` | planned |
| U9   | The draws of NumPy that the folds need, in `@zukhruf/random`                                 | -                                                  | planned |
| U10  | The linear Choice family                                                                     | `heads/linear_choice.py`                           | planned |
| U11  | The regress family: ridge and kernel ridge, with an 80% interval                             | `heads/regression.py`                              | planned |
| U12  | Gradients and AdamW for the fixed modules of the heads (addition: Venn uses PyTorch)         | -                                                  | planned |
| U13  | The residual Choice family                                                                   | `heads/family.py`                                  | planned |
| U14  | The OutcomeService and its heads                                                             | `outcomes.py`, `heads/outcome.py`                  | planned |
| U15  | A reader on Transformers.js (addition: Venn reads with PyTorch)                              | `reader.py`                                        | planned |

## Read the weights of a head

```ts
import { loadWeights } from '@zukhruf/vector-decisions';

const weights = await loadWeights('venn-1/universal.safetensors');
weights.get('temperature'); // { shape: [], values: Float32Array [0.0670204] }
weights.get('none.0.weight')?.shape; // [512, 1536]
```

`loadWeights(path)` reads a [safetensors](https://github.com/huggingface/safetensors#format) file and gives a `Map` from the name of each tensor to its shape and its values, in row-major order. It reads float32 tensors only, because the head of Venn has no other type. Venn reads the same file with `safetensors.torch.load_file` (`venn/runtime.py:35`).

A safetensors file has three parts: 8 bytes with the length of the header, a JSON header that gives the type, the shape and the byte range of each tensor, and the bytes of the tensors. The format does not let a file run code when it is read, as Python's `pickle` does. `loadWeights` throws a `SafetensorError` when a file breaks a rule of the format:

- the file is shorter than 8 bytes, or the length of its header is longer than the rest of the file;
- the header is not JSON, or does not start with `{`;
- an entry of the header is not `{ dtype, shape, data_offsets }` with a shape of whole sizes from 0 up and a pair of byte offsets from 0 up, or its type is not `F32`;
- a byte range begins after it ends, or its length is not the product of the shape times 4;
- the byte ranges leave a gap, overlap, or do not end where the data ends.

The tests compare `loadWeights` with safetensors 0.8.0, bit for bit, on files that its Python library writes (`src/safetensors/fixtures/generate.py`).

## Get the head

```ts
import { join } from 'node:path';

import {
  downloadHead,
  loadWeights,
  modelDirectory,
} from '@zukhruf/vector-decisions';

const directory = await modelDirectory(await downloadHead());
const weights = await loadWeights(join(directory, 'universal.safetensors'));
```

`downloadHead({ cacheDir? })` downloads the files of the venn-1 head (`markrussinovich/venn-1`) at the commit `e618a6919e5a15c6ced46c9874424363c2955283`, as Venn's `cli.download_head` does (`venn/cli.py:50`). It downloads `manifest.json` first, then each file that the manifest lists, and gives their directory. The download goes through `@huggingface/hub`, into the cache of Hugging Face: `cacheDir`, else `HF_HUB_CACHE`, else `HF_HOME/hub`, else `~/.cache/huggingface/hub`. Python's `huggingface_hub` uses the same folder in the same order, so Python and this package share one copy. The revision is a commit, so a file that the cache already holds needs no network.

`modelDirectory(path)` reads `manifest.json` in the directory and compares the SHA-256 of each file that it lists with its digest, as Venn's `runtime.model_directory` does (`venn/runtime.py:11`). Then it gives the directory back. It throws an `InvalidModelArtifactError` with the name of the file when:

- the bytes of a file do not match its digest;
- a name is not a file of the directory itself, for example `../x`, `sub/x` or an absolute path. A link into the `blobs` folder of the Hub cache is a file of the directory;
- `manifest.json` is not JSON, or is not `{ "sha256": { <file>: <digest> } }`.

A directory with no `manifest.json`, or without a file that the manifest lists, gives the `ENOENT` error of Node.

The package does not read `VENN_MODEL_DIR`, as Venn does when no path is given: the host gives the path.

## Ask the head

```ts
import { CosineAbstention, PreparedQuestion } from '@zukhruf/vector-decisions';

const head = CosineAbstention.fromWeights(weights);
const question = new PreparedQuestion(head, questionVector, [
  billingVector,
  loginVector,
]);
question.logits([stateVector]); // [[logit of billing, logit of login, logit of none]]
```

`CosineAbstention.fromWeights(weights)` makes the head of Venn (`venn/heads/abstention.py`) from the weights that `loadWeights` reads. It throws an `InvalidHeadWeightsError` when a tensor of the head is missing, or when the shapes of the tensors do not fit together.

`new PreparedQuestion(head, question, options)` prepares a question, as Venn's `venn.index.apply.PreparedQuestion` does:

1. It subtracts the centroid of the options from each option and from the question, and makes each a unit vector (`venn.index.prewarm`). What the options share goes away, and only what makes them different stays. A vector that this makes zero stays zero, as `F.normalize` of PyTorch keeps it.
2. It applies the question half of the first layer of the "none" network one time.

`logits(states)` gives one row for each unit state vector:

- the logit of each option: the cosine of the state with the centered option, divided by `temperature` (0.067 for venn-1);
- then the logit of "none": the second layer over the GELU of the first layer (the state half, plus the question half), plus `none_intercept`.

A question, an option or a state that has another number of values than the head reads throws a `DimensionMismatchError`. `logits` computes in float64. The tests compare it with Venn's logits in float64, from the same float32 weights and vectors, to 1e-12. Venn computes in float32, which differs from float64 by about 1e-6 on venn-1.

The package does not port Venn's `ContextAbstention`, an older head that Venn reads only for families that it saved before, and its context terms of the "none" network.

## Make the reader

```ts
import { embedMany, wrapEmbeddingModel } from 'ai';

import { open } from '@zukhruf/sqlite-open';
import { embeddingGemmaPrompt, vectorCache } from '@zukhruf/vector-decisions';

using database = open('vectors.sqlite');
const reader = wrapEmbeddingModel({
  model, // any AI SDK embedding model of EmbeddingGemma 2, for example a llama.cpp server
  middleware: [
    embeddingGemmaPrompt('Classification'),
    vectorCache({ database }),
  ],
});
const { embeddings } = await embedMany({
  model: reader,
  values: ['The checkout page is broken'],
});
```

The reader is an AI SDK embedding model, so any code of the AI SDK can use it. Its two middlewares port the embed path of Venn's `DecisionService.embed` (`venn/server.py:135`):

- `embeddingGemmaPrompt(prompt)` puts the prefix of the prompt before each text, as EmbeddingGemma 2 defines it: `Classification` (`task: classification | query: `), `SentenceSimilarity` or `Clustering`. The venn-1 head reads vectors of the `Classification` prompt.
- `vectorCache({ database })` keeps the vector of each text in the table `vector_cache` of a SQLite database that the caller opens and closes. It asks the model only for the texts that the table lacks, each one time. It normalizes each new vector in float64 and stores it as float16, as Venn does, and it gives float32 unit vectors. A vector that is not finite, or a result that does not give one vector of the same length for each text, throws an `InvalidEmbeddingError` and stores nothing.

The prompt middleware comes first, so the cache keeps the text with its prefix, and each prompt has its own vectors. The key is the SHA-256 of the provider and the id of the model and the text. Venn's key names its one pinned reader instead. Here the model is the caller's, so the key names the model that makes the vector.

The tests compare the vectors with the vectors of Venn's own `DecisionService.embed` for the same raw vectors (`src/reader/fixtures/generate.py`). They differ by at most 2 units in the last place of float32, because Venn adds up the norm in float32.

## Decide

```ts
import { open } from '@zukhruf/sqlite-open';
import { DecisionService, downloadHead } from '@zukhruf/vector-decisions';

using database = open('vectors.sqlite');
const service = await DecisionService.load({
  model, // any AI SDK embedding model of EmbeddingGemma 2
  database,
  directory: await downloadHead(),
});
const { answers, vector } = await service.decide({
  state: 'The checkout page is broken and my card was charged twice',
  questions: {
    team: {
      instructions: 'Who owns this ticket?',
      options: ['Login problems', 'Checkout and payments'],
    },
    urgency: {
      type: 'Score',
      instructions: 'How urgent is it?',
      options: ['Can wait', 'Should be fixed soon', 'Blocking'],
    },
    defect: {
      type: 'Noul',
      instructions: 'Is the software broken?',
      options: ['A request or a question', 'The software is broken'],
    },
  },
});
answers.team; // { answer, probabilities: { 'Login problems', 'Checkout and payments', none }, confidence, calibrated: false }
```

`DecisionService.load({ model, database, directory })` makes the service, as the constructor of Venn's `DecisionService` does (`venn/server.py:57`):

1. It checks the model directory with `modelDirectory`.
2. It reads `config.json`. The config must name the reader `google/embeddinggemma-2` at the revision `f9972ac22e696a105c482202646979e33e4b5a1e`, with 768 numbers, and give a `choice_temperature`. Another config throws an `InvalidModelArtifactError` for `config.json`.
3. It reads the head from `universal.safetensors`.
4. It puts the two middlewares of the reader around `model`: the `Classification` prompt, then the vector cache in `database`. The caller opens and closes the database.

`decide({ state, questions })` answers each named question about the state, as Venn's `decide` does (`venn/server.py:912`). The state is a text, `{ text }` or `{ vector }`, or a plural state: `{ texts }` with 1 to 512 texts, or `{ vectors }` with 1 to 512 vectors. Each text or vector of a plural state is a row. A question has these fields:

- `type`: `Choice` (the default), `Score`, `Noul` or `IndexApply`.
- `instructions`, a text (the default is "What is the topic?"), or `instructionsVec`, a vector.
- `options`: 1 to 256 options. An option is a text, or `{ label, vector }`. An option without a vector is the text of its label.
- `threshold`: a number from 0 to 1.
- `scores` (Score only): one number for each option. The default is 0, 1, 2 and so on.
- `rowCap` (IndexApply only): the count of rows to answer, from the first, 0 to 512. The default is all the rows.
- `batchSize` (IndexApply only): the count of rows in a batch, 1 to 65,536 (the default).

The reader embeds the texts. The head gives the logits of the options and of "none" for the unit vector of the state. Each answer has the `probabilities` of the labels and of "none", the `confidence` (the largest probability), and `calibrated`, which is `false`, because the package has no calibration yet (U7):

- **Choice**: the probabilities are the softmax of the logits divided by `choice_temperature`. The answer is the first label with the largest probability. If the confidence is less than the threshold, the answer is "none".
- **Score**: the answer of a Choice, and `expectedScore`: the sum of the probability times the score of each option, divided by the sum of the probabilities of the options. The probability of "none" does not count, so `scoreConditionedOnNotNone` is `true`.
- **Noul**: the probability of "none" comes first: the sigmoid of the "none" logit minus the logsumexp of the option logits, divided by `choice_temperature`. The options share the rest by softmax. The answer is "none" if the probability of "none" is equal to or more than the threshold (0.5 without one). Else the answer is "in_scope".
- **IndexApply**: `{ rows, batches }`. `rows` holds the answer of a Choice for each of the first `rowCap` rows, with the index of the row as its `id`. `batches` is the count of batches of `batchSize` rows. Choice, Score and Noul answer one state only, and IndexApply a plural state only.

```ts
const { answers } = await service.decide({
  state: { texts: ['I cannot sign in', 'Where is my parcel?'] },
  questions: {
    team: {
      type: 'IndexApply',
      instructions: 'Who owns this ticket?',
      options: ['Login problems', 'Shipping and delivery'],
    },
  },
});
answers.team; // { rows: [{ answer, probabilities, confidence, calibrated: false, id: 0 }, { …, id: 1 }], batches: 1 }
```

The `vector` of the decision is the vector of the state when the reader embedded the state, the vectors of a state of texts, else `null`.

`registerQuestion(question)` prepares a question for many decisions, as Venn's `register_question` does (`venn/server.py:854`). It checks the instructions and the options as `decide` does, and the reader embeds their texts into the vector cache. It gives a handle: the SHA-256 of the question in the canonical JSON of RFC 8785, without the threshold, so the same question gets the same handle. In a request, `{ questionRef: handle }` asks the registered question, and can also give a `threshold`, a `rowCap` and a `batchSize`:

```ts
const team = await service.registerQuestion({
  instructions: 'Who owns this ticket?',
  options: ['Login problems', 'Checkout and payments'],
});
await service.decide({
  state: 'I cannot sign in',
  questions: { team: { questionRef: team, threshold: 0.5 } },
});
```

`decide` and `registerQuestion` throw a `ContractError` with a `code` and a `status` (422 if the table gives none) for a request that breaks a rule of Venn. `decide` checks in Venn's order: the questions, the state, then each question in turn.

| Code                | The request has                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `question_limit`    | no question, or more than 32                                                                                                    |
| `state_texts`       | a state of no texts, or of more than 512                                                                                        |
| `state_shape`       | a state of texts that also has a text, a vector or vectors                                                                      |
| `invalid_text`      | an empty text, or a text of more than 32,768 characters. A character is a code point, as Python counts it                       |
| `invalid_vector`    | a vector with another number of values than the head reads, or with a value that is not finite in float32, or `{ vectors: [] }` |
| `state_limit`       | a state of more than 512 vectors                                                                                                |
| `zero_vector`       | a vector of norm 1e-12 or less                                                                                                  |
| `question_handle`   | a `questionRef` that `registerQuestion` did not give (status 404)                                                               |
| `prewarm_override`  | a `questionRef` with another field than `threshold`, `rowCap` and `batchSize`                                                   |
| `threshold`         | a threshold that is not from 0 to 1                                                                                             |
| `question_type`     | a type that is not `Choice`, `Score`, `Noul` or `IndexApply`                                                                    |
| `option_limit`      | no option, or more than 256                                                                                                     |
| `option_labels`     | two options with the same label, or an option with the label "none"                                                             |
| `index_input`       | an IndexApply question about one state                                                                                          |
| `stream_limit`      | a `rowCap` that is not a whole number from 0 to 1,000,000, or a `batchSize` that is not a whole number from 1 to 65,536         |
| `stream_required`   | a `rowCap` of more than 512 (status 413): `decide` answers at most 512 rows                                                     |
| `unsupported_input` | a plural state for a Choice, Score or Noul question                                                                             |
| `rubric`            | scores that are not one finite number for each option                                                                           |
| `prewarm_type`      | for `registerQuestion`, a type that is not `Choice`, `Score`, `Noul` or `IndexApply`                                            |

The differences from Venn, and the rules of Venn that the package keeps, are in [ADR 0003](docs/adr/0003-decide-leaves-out-the-fields-of-venns-own-reader-and-keeps-venns-rules-of-an-answer.md):

- The request has no `model`, and the decision has no `vector_tag` and no `model`: the reader is the caller's. So no request gives the code `embedder_revision`.
- An option is a text or `{ label, vector }`. Venn also takes a bare vector, and an object without a label, whose label is its index.
- The types refuse what Venn refuses with the codes `request_shape`, `question_shape` and `instructions` (a matrix as `instructionsVec`), and thresholds, scores and vectors that are not numbers.
- The names are in camelCase: `instructionsVec`, `expectedScore`, `scoreConditionedOnNotNone`, `questionRef`, `rowCap`, `batchSize`.
- The reader embeds the state in one call and the texts of each question in one call. Venn embeds each text alone.
- The package computes in float64, and Venn in float32. On the fixture, the probabilities differ by at most 1.5e-7.

The differences of `registerQuestion` are in [ADR 0004](docs/adr/0004-register-question-takes-no-name-and-its-handle-is-the-sha-256-of-the-rfc-8785-json-of-the-question.md): it takes no name, its handle is not Venn's, and the types refuse a threshold, which no decision reads.

The tests compare `decide` and `registerQuestion` with Venn's own `DecisionService.decide` and `register_question` and the real venn-1 head, for the same raw vectors (`src/service/fixtures/generate.py`). The head is not in the repository, so these tests run in the `test-network` target.
