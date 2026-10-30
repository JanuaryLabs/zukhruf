# Hybrid search fixture

`expected.json` holds what Python MTEB 2.26.28 gave for `HybridSearch` and its three fusions. `hybrid.golden.test.ts` compares this package with it, to the last bit. `generate.py` writes it. Do not edit `expected.json` by hand. Run the script again:

```sh
uv run packages/mteb/src/models/fixtures/hybrid/generate.py
```

The hybrids search the folder task of the BM25 fixture (`../../model-implementations/fixtures/bm25`). The task removes the instruction of the query `q10`, because the dataloader of an encoder stops when only some queries have an instruction.

One hybrid joins BM25 with a one-hot encoder. The encoder gives each text a vector of 8 values. The value at the index (the sum of the Unicode code points of the text) modulo 8 is 1. The other values are 0. Thus each cosine is exactly 0 or 1, and the order of a BLAS sum cannot change a bit. In Python, the encoder is a subclass of `AbsEncoder`. In TypeScript, it is an `AiSdkEncoder` over an AI SDK model that gives the same vectors.
