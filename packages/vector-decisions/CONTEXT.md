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
The thing that a question is about: a text, or its vector. A plural state is several texts or several vectors.
_Avoid_: input, item, document

**Row**:
One text or one vector of a plural state. IndexApply answers each row, and the index of the row is its id.
_Avoid_: record, entry, item

**Question**:
A typed request about a state: Choice (which option), Score (which level of a scale), Noul (yes or no) or IndexApply (which option, for each row of a plural state).
_Avoid_: query, prompt

**Question handle**:
The name that `registerQuestion` gives to a question, so that a decision can ask it again with `questionRef`. It is the SHA-256 of the question without its threshold.
_Avoid_: question id, token, prewarm key

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

**Logit**:
The score of one option, or of "none", before softmax turns the scores into probabilities. A larger logit is a more probable option.
_Avoid_: score (for a logit), weight

**Temperature**:
The number that divides the cosines to give the option logits. A small temperature makes small differences of cosine into clear differences of probability.
_Avoid_: scale, sharpness

**Centering**:
The step that subtracts the centroid of the options from each option and from the question, before the cosines. Venn calls it prewarm.
_Avoid_: normalisation (for the whole step), whitening

**Prepared question**:
A question whose options are centered and whose part of the "none" network is computed one time, so that each state costs only its own part.
_Avoid_: compiled question, cached question

**Prompt**:
The task of the reader for a text, which the reader puts before it as a prefix: Classification, SentenceSimilarity or Clustering. Each prompt gives other vectors for the same text.
_Avoid_: instruction (for a prompt), template

**Vector cache**:
The table that keeps the vector of each text that the reader embedded, by the model and the text, so that the model embeds each text one time.
_Avoid_: store, index (for the cache)

**Answer**:
The label that a question gives for a state, or "none". A Noul question answers "none" or "in_scope". Each answer also gives the probability of each option and of "none".
_Avoid_: prediction, result, verdict

**Confidence**:
The largest probability of an answer, before the threshold applies.
_Avoid_: certainty, score

**Threshold**:
The smallest confidence that a question accepts: with less, the answer is "none". For a Noul question, the probability of "none" from which the answer is "none".
_Avoid_: cutoff, minimum

**Expected score**:
The scores of the options of a Score question, each times its probability, added up and divided by the sum of the probabilities of the options. The probability of "none" does not count.
_Avoid_: average, mean score, expected value

**Decision model**:
The AI SDK model that answers the questions of `experimental_decide`. `DecisionServiceModel` asks each question of a call as a Choice of one `DecisionService`.
_Avoid_: provider, adapter, decider

**Criterion**:
The description of one option of an AI SDK question, by the name of the option. A choice can have one criterion without a description: the abstention.
_Avoid_: rubric item, label (for the description)

**Abstention**:
The criterion of a choice without a description. It is not an option: its probability is the probability of "none".
_Avoid_: null option, fallback, other

**Level**:
One criterion of a score question, by its place from zero. The score is the sum of each probability times its level.
_Avoid_: grade, step, bucket

**Probability of none**:
The probability that the head gives to "none" for a question. It is the probability of the abstention of a choice. The decision model gives it in `providerMetadata.vectorDecisions.noneProbability`.
_Avoid_: abstention score, none score
