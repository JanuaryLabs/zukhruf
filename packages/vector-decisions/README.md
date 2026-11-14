# @zukhruf/vector-decisions

> **Status: in progress.** Units 0 to 2 of 16 are done: the package downloads the venn-1 head, checks it and reads its weights. The decisions are in [ADR 0001](docs/adr/0001-port-the-library-core-of-venn-at-one-commit-one-unit-at-a-time.md).

A program often needs a decision about a text, not new text: which team owns a ticket, how urgent it is, or if it is a defect. A decision model such as Jev reads the text again for each question. This package answers the same typed questions from vectors. A reader embeds each text one time. Then a small head compares the vector of the text with the vectors of the options. This package is a TypeScript port of the library core of [Venn](https://github.com/markrussinovich/venn-vdm) (commit `7b2042e`).

The package is private: a workspace reaches it through its path. The words are defined in [CONTEXT.md](CONTEXT.md).

## Units

Each unit works and has tests alone, and it composes with the units before it.

| Unit | What it does                                                                                 | Venn source                           | State   |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------- | ------- |
| U0   | The package                                                                                  | -                                     | done    |
| U1   | Reads the tensors of a `.safetensors` file                                                   | `runtime.load_weights`                | done    |
| U2   | Downloads the files of a model at one revision and checks their SHA-256                      | `runtime.model_directory`             | done    |
| U3   | The head: the option logits and the "none" logit of a state                                  | `heads/abstention.py`, `index/*.py`   | planned |
| U4   | The reader: the Classification prefix and the vector cache, around an AI SDK embedding model | `reader.py`, `server.py`              | planned |
| U5   | `DecisionService.decide`: Choice, Score, Noul, IndexApply and prepared questions             | `server.py`                           | planned |
| U6   | An AI SDK decision model over a `DecisionService` (addition: Venn has an HTTP route)         | `decisions.py`                        | planned |
| U7   | Calibration: the temperature fit, on an optimizer that moves out of mteb                     | `heads/calibration.py`                | planned |
| U8   | NearestReference, SetMembership and PopulationShift                                          | `index/decision.py`, `index/shift.py` | planned |
| U9   | The draws of NumPy that the folds need, in `@zukhruf/random`                                 | -                                     | planned |
| U10  | The linear Choice family                                                                     | `heads/linear_choice.py`              | planned |
| U11  | The regress family: ridge and kernel ridge, with an 80% interval                             | `heads/regression.py`                 | planned |
| U12  | Gradients and AdamW for the fixed modules of the heads (addition: Venn uses PyTorch)         | -                                     | planned |
| U13  | The residual Choice family                                                                   | `heads/family.py`                     | planned |
| U14  | The OutcomeService and its heads                                                             | `outcomes.py`, `heads/outcome.py`     | planned |
| U15  | A reader on Transformers.js (addition: Venn reads with PyTorch)                              | `reader.py`                           | planned |

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
