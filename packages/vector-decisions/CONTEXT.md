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
