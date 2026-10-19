# A scan can be listed in parts

The Instagram source reads the posts of a profile through Instagram's web API. One page holds at most 33 posts, and @propertyplus.jo has 3,479 posts, so one complete scan is 106 pages. Instagram answers 429, "Please wait a few minutes", to a client that reads too much, so a source reads 10 pages in each run. A complete scan therefore takes 11 runs.

A diff judged the vanished keys of each call. A call that listed 10 pages made every other post a vanished key, and `ClosedWorld` deleted it. A source could not keep the rows of the posts that the scan had not reached yet.

## Decision

`diff` and `diffGroups` take the option `continues`. A call with `continues: true` is one part of a scan:

- It yields an upsert for each new or changed record that it lists, at once.
- It judges no vanished key. It saves the snapshot with every key, and the keys that the open scan listed so far (`listed`).
- The call without `continues` is the last part. It judges each saved key that no part listed, with the policy of the differential.
- One part cannot list a key twice. Two parts can, because a page of the upstream can move while the scan goes on.

A source saves the snapshot after each part, so a part is also a commit, and a failed run keeps the parts before it.

## Considered Options

- **The source keeps its own listed keys and gives a `Coverage` policy that covers no key until the last part.** It works, but each source that pages a slow upstream must keep a second set of keys beside the snapshot, and the two sets can disagree.
- **A reload of the target table, as an ELT pipeline does it.** The pipeline loads the scan into a hidden table, and the reload ends when a run ends with no failure. A run that stops after 10 pages ends with no failure, so a part would replace the table. A reload also keeps new rows hidden until it ends, and new posts must show in the next run.
- **Airbyte's resumable full refresh.** Airbyte keeps the page token of a full refresh only between the attempts of one job, and the platform deletes it at the next job. Its truncate refresh keeps all rows hidden until the sync ends. Neither lets one scan go on through syncs that end with success.
- **The option `continues` on the differential.** This option was selected.

## Consequences

- While a scan is open, its state holds one JSON key for each listed key. For 3,479 posts, this is less than 100 KB.
- A record that the upstream deletes after a part listed it is deleted only by the last part of the next scan.
- A scan in parts never deletes a record before its last part. If a source never ends the scan, the diff never deletes.
- In `diffGroups`, a part that reads a group again replaces what the snapshot holds for it. A key that left the group then belongs to no group, so the snapshot keeps it with the unknown keys until the last part judges it. Without that, a comment removed from a post that a part read again would never be deleted.
- The saved state of a one-call scan has the same shape as before. `listed` is in the state only while a scan is open.
- A pipeline that gives `continues` departs from Airbyte on purpose. In Airbyte, a successful sync always ends a full refresh.
