# Fencing

A holder can lose its lease and not know it, for example when its process freezes. When it continues, it can write over the work of a newer holder. A fencing token lets the protected resource refuse that write. The lease warns the holder. The fencing token protects the resource. These are two concepts, and the lease is in `@zukhruf/lease`.

## Language

**Fencing token**:
An integer that a holder gets with each grant. Each grant of a key gets a token that is higher than the tokens of all earlier grants of that key. The holder sends its token with each write to a fenced resource.
_Avoid_: Version, revision, lock ID, UUID, timestamp (a token is not a time)

**Token source**:
The object that makes the fencing tokens of an issuer. The issuer asks it for the next token of a key, one at a time for each key.
_Avoid_: Generator, counter (a counter is one kind of token source), sequence

**Fenced resource**:
A resource that keeps the highest token that it accepted, and refuses a write with a lower token. It compares the token and does the write in one atomic step. Only a fenced resource is protected by tokens.
_Avoid_: Guarded resource, protected store

**Fenced lease**:
A lease that also has a fencing token. An issuer of fenced access, for example a mutex or a single flight, gives it to the holder.
_Avoid_: Lock handle, ticket

**Stale holder**:
A holder that lost its lease and still writes. A fenced resource refuses its writes, because a newer holder wrote with a higher token.
_Avoid_: Zombie, old owner

**Epoch**:
The number of a term of a leader, in the high 32 bits of a token from `EpochTokenSource`. Each new term has a higher epoch. Thus each token of a newer term is higher than each token of an older term.
_Avoid_: Generation, era, term (a term is the time that one leader leads; the epoch is its number)
