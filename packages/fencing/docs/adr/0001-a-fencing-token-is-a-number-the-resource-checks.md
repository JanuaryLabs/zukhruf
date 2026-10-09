# A fencing token is a number that the resource checks

A holder can lose its lease and not know it. Its process can freeze in a long garbage collection, its network can split, or a failover can give the key to a new holder. When the old holder continues, it writes over the work of the new holder. The signal of the lease warns the holder (mutex ADR 0013), but the holder can write before the issuer sees the loss. Thus a warning to the holder cannot protect the resource.

The mutex, the single flight, and the election each need an answer to this problem. This package keeps the technique that `@zukhruf/mutex` used since its first version, because each system that we examined uses the same parts:

1. **A token is an integer that grows strictly with each grant of a key.** Martin Kleppmann names it a fencing token in "How to do distributed locking" (2016). Chubby gives a sequencer with a lock generation number. Hazelcast `FencedLock` gives a fence. etcd gives the revision of the lock key.
2. **The protected resource checks the token, not the holder.** The holder cannot know that a newer holder exists. The resource saw the newer token. Chubby gives `CheckSequencer()` to the server that the holder writes to. The documentation of etcd says that "the lock feature of etcd itself cannot be used for protecting external resources".
3. **The check and the write are one atomic step.** In SQL: `UPDATE … SET …, fence = :token WHERE … AND fence <= :token`. An equal token passes, because one holder can write two times with its token. A lower token fails. A read before a write leaves a gap in which a stale write can occur.
4. **A durable resource needs durable tokens.** The resource keeps the highest token after a restart. A counter in memory starts again at 1, and then the resource refuses each new write. `FileTokenSource` keeps its counters in files, and an election keeps its epoch in a file.
5. **A new leader outranks each grant of an older leader.** `EpochTokenSource` puts the epoch of the term in the high 32 bits and a counter in the low 32 bits. ZooKeeper uses the same layout in its `zxid`. Raft uses a term, and Kafka uses a leader epoch, for the same reason.

The token goes over a wire and into databases as decimal text, and a resource compares it as a 64-bit integer. A JavaScript number loses digits above 2^53, and `JSON.stringify` refuses a `bigint`. Thus `FencingToken.parse` is the one reader of the text form. It accepts only decimal digits. Before this package, two protocols each had their own check, and the checks went apart: one accepted a minus sign, and the other did not. A token is never negative.

## Considered Options

- **A random value or a UUID.** It is unique, but it has no order. A resource cannot tell a newer holder from an older one. Redlock gives a random value, and Kleppmann shows that a random value cannot fence.
- **A UUIDv7 or a time.** A UUIDv7 has an order only to the millisecond, and it is random in that millisecond. Mutex ADR 0003 measured `crypto.randomUUIDv7()` in Node 26: 50,160 of 100,000 values from one thread were lower than the value before them, and 936 of 2,000 grants across two threads were in the wrong order. A clock of the wall can also go back. A resource would refuse correct holders and accept stale holders.
- **A scope in the token.** Chubby puts the name of the lock in its sequencer, so a resource cannot compare tokens of two locks. A token of zukhruf is one integer on the wire of the mutex and of the single flight, and published versions read that wire. A scope would change the wire. Thus the rule is in the documentation instead (see Consequences).
- **Transactional fencing in the store of the lock.** etcd gives `IsOwner()`, a compare that a transaction in etcd includes. It protects only the state in etcd. A resource in another store, for example a database or a file, still needs a token. This option does not fit a package whose resources are in other stores.
- **A strictly growing integer that the resource checks.** This option was selected.

## Consequences

- A fenced resource compares the tokens of one key, from one token source. A token carries no key and no token source, so two tokens of different keys or of different token sources cannot be compared. A counter in memory and a counter in a file can both give token 7.
- The token sources keep the bytes of the earlier mutex versions: the `.fence` file name from `safeFileName`, the decimal content with no newline, an absent file read as 0, the write with `durableWrite`, and the layout `epoch << 32 | counter` with the limits 2^31 for the epoch and 2^32 for the counter. Processes of earlier versions and of this package share the same files and compare the same tokens.
- A holder gets a `FencedLease`: the lease of `@zukhruf/lease` and a token. An election gives a term with an epoch and no token, so `@zukhruf/election` does not depend on this package.
- Tokens protect only a fenced resource. An email or a call to an API that does not compare tokens is not protected.
