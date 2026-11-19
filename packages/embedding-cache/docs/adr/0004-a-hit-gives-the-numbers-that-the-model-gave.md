# A hit gives the numbers that the model gave

Status: accepted by Ezz on 2026-11-19.

A cache can keep the vectors as float32 (4 bytes a value, as .NET's `Embedding<float>`) or keep the model's numbers exactly (8 bytes a value, as LangChain keeps JSON). Rounding to float32 changes what the model returned and erases a precision or an encoding that a model gives (int8 and binary embeddings exist). Keeping the numbers exactly also makes a hit and a miss give the same numbers, with no rounding.

Ezz, 2026-11-19: "I don't want convenience ... when we design things, I want to make use of all the features that we are trying to abstract instead of limiting what beneath through our abstraction."

## Decision

- The middleware gives back and the stores keep the numbers of the model exactly.
- `SqliteEmbeddingCacheStore` and `SqlServerEmbeddingCacheStore` keep each vector as the bytes of its float64 values, little-endian, which give back each number exactly. SQL Server's `VECTOR` type keeps float32 or float16, so the SQL Server store uses `VARBINARY(MAX)`.

## Consequences

- A stored value takes 8 bytes. A host that wants smaller entries writes its own store.
