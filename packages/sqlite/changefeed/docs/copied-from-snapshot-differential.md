# Copied from @zukhruf/snapshot-differential

`src/column-hashes.ts` (`canonical`) copies the rule of `@zukhruf/snapshot-differential`'s `src/fingerprint.ts` (`canonical`) that makes one text for each value: a string is its JSON, a bigint is its digits and `n`, bytes are `#` and their base64url.

| Source                                                 | Copy                                                 | What changed                                                                               | Why                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `snapshot-differential/src/fingerprint.ts` `canonical` | `sqlite/changefeed/src/column-hashes.ts` `canonical` | One value, not a record: no objects, no arrays. `-0` is `-0`, where the source refuses it. | The changefeed hashes each column of a row (ADR 0009); SQLite gives `-0.0` as `-0`. |

Rule of Three: this is strike 2. Mirror each fix of the rule in both copies, and name both files in the commit. A third copy extracts the rule (agent-backlog, trigger "a third consumer").
