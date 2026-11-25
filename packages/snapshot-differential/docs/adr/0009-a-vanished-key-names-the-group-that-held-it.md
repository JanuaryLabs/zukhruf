# A vanished key names the group that held it

Superseded in part on 2026-11-25 (#4468) for where the group of a waiting key is saved. It is the `holder` of the key's entry in `unknown`, not a `holders` field ([ADR 0011](./0011-a-grouped-diff-gives-what-changed-in-each-keyed-collection.md)).

A grouped scan diffs the records of each group, such as the records that one web page gave. The deletion policy judged each vanished key by its key and its `expiresBy` only. So it could not tell a key that vanished from a group the scan read again from a key of a group that the scan did not list.

The web source of elt needs that difference (elt backlog item 3235). Its groups are pages. A page that the crawl reads again with fewer records, or a page that answers 404 or 410, no longer has the records it gave, so their rows must go: Apache Nutch's indexer deletes gone documents (`-deleteGone`), StormCrawler sends them to its deletion stream, and dlt's merge deletes the rows of a `merge_key` that a load gives again without them. A page that only left the listings that named it can still exist, so its records must not be deleted (source-web-pages ADR 0005). A predicate on the key, `Coverage`, cannot tell the two cases when the stream's key is not the page, such as a product's id that a page of a shop's product list gives.

The differential knows both facts: each saved group holds its keys, and each scan knows the groups it listed. In a scan in parts, a key that vanishes in an earlier part waits in `unknown` for the last part's judgment, and its group was lost there.

## Decision

1. **A vanished key names its group.** In a grouped scan, `VanishedRecord.group` is `{ key, listed }`: the key of the group that held the record in the last committed scan, and whether this scan listed that group. A scan lists a group when it reads it, keeps it, or finds its fingerprint unchanged. An ungrouped scan gives no `group`, nor does a key that a policy judged `unknown` in an earlier scan, which no group holds any more.
2. **A scan in parts keeps the group of each waiting key.** While a scan in parts is open, its state keeps `holders`, the group of each key waiting in `unknown` for the last part's judgment, beside `listed`, the groups its earlier parts listed (ADR 0002). The last part tells the policy both.
3. **The package adds no policy.** A source writes the subclass for its own judgment, as ADR 0001 says: the web source's policy deletes the key of a listed group and lets the key of another group expire.

## Considered Options

- **A predicate on the key, `Coverage`.** It needs the group in the key, which a stream keyed by a product's id does not have. This option was rejected.
- **The source emits the deletes itself from the saved state.** The source would read the differential's state and judge keys outside its policy, against ADR 0001. This option was rejected.
- **The differential tells the policy the group and whether the scan listed it.** This option was selected.

## Consequences

- A policy can judge the groups of a grouped scan as complete partitions.
- The saved state of an open scan in parts can have `holders`, only while a key waits for the last part's judgment.
