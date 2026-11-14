# Vector decisions

> This glossary goes with [README.md](README.md).

A program asks a typed question about a text, such as "Who owns this ticket?", and gets a probability for each option. This context answers the question from vectors: a reader puts each text on a map one time, and a head measures where the text is against the options. The words are the words of Venn, the Python package that this package ports.

## Language

**Reader**:
The embedding model that turns a text into a vector. Venn's reader is EmbeddingGemma 2, with the Classification prompt before each text.
_Avoid_: encoder, embedder

**Vector**:
The 768 numbers that the reader gives for one text: its place on the map.
_Avoid_: embedding (for the value; use it only for the act), point

**State**:
The thing that a question is about: a text, or its vector.
_Avoid_: input, item, document

**Question**:
A typed request about a state: Choice (which option), Score (which level of a scale) or Noul (yes or no).
_Avoid_: query, prompt

**Option**:
One answer that a question offers. Its description is a criterion.
_Avoid_: label (for the option of a generic question), class

**Head**:
The small model that turns the vector of a state and the vectors of the options into one logit for each option and one for "none". Venn's head is `venn-1`.
_Avoid_: classifier, judge

**Tensor**:
A block of float32 numbers with a shape, in row-major order. A shape `[]` is one number.
_Avoid_: array, matrix (for a tensor of any shape)

**Weights**:
The tensors of a head, by name, as its safetensors file holds them.
_Avoid_: checkpoint, state dict, parameters (Venn's 787,457 parameters are the weights without `temperature` and `none_intercept`)

**Revision**:
One commit of a repository on the Hugging Face Hub. A branch such as `main` can move, but a commit does not.
_Avoid_: version (for a revision), tag

**Model directory**:
The folder that holds the files of a head: `config.json`, `universal.safetensors` and `manifest.json`.
_Avoid_: bundle, assets folder, checkpoint

**Manifest**:
The `manifest.json` of a model directory: the SHA-256 of each of its files, by name.
_Avoid_: checksum file, index
