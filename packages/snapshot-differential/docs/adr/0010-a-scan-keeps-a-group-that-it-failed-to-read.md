# A scan keeps a group that it failed to read

The elt web source diffs each page of a crawl as a group, and its policy deletes a key that vanished from a group that the scan listed ([ADR 0009](./0009-a-vanished-key-names-the-group-that-held-it.md)). A page that answers 503 has no records in that scan. The source gave no group for it, so the page was not listed, its keys vanished at the end of the scan, and the policy let them expire. The snapshot then had no keys for the page. When the page answered again with fewer records, or when its third failure in a row made it gone, no key vanished from it, and the rows of the records that it no longer gave stayed (elt backlog item 3235).

A failure is not an answer about the records. Apache Nutch keeps the indexed document of a URL whose fetch failed and that it will try again (`STATUS_FETCH_RETRY`), and its indexer deletes the document only when the URL is gone (`-deleteGone`). A file scan has the same need: a file that the scan could not open still has the records that it gave.

The source cannot give a kept group for the page ([ADR 0004](./0004-a-scan-can-keep-a-group-without-reading-it.md)). A kept group that the snapshot does not have is an error, because the source vouches for a group that the diff never saw. A page whose first visit failed is such a group, and only the differential knows whether its snapshot has the group.

## Decision

1. **A failed group keeps what the snapshot has of it.** `diffGroups` takes `{ key, failed: true }`. The scan lists the group, does not read it, and yields no change for it. The diff keeps its saved fingerprint and records as it keeps a group that an open scan has not reached ([ADR 0002](./0002-a-scan-can-be-listed-in-parts.md)): its keys do not vanish, and in a scan in parts the last part does not judge them.
2. **A record that another group gives moved.** The source does not know what a failed group holds now. A record that a group of the same scan gives, such as a product that moved to the page before a page that answered 503, leaves the failed group with no change, whatever the order of the two groups. A kept group, in contrast, claims its keys, because the source vouches that it did not change.
3. **A failed group that the snapshot does not have keeps nothing.** It is no error, and the new snapshot has no group for it.
4. **A failed group is not a kept group.** A kept group still says that the input did not change, and a kept group that the snapshot does not have is still an error.

## Considered Options

- **A kept group that the snapshot does not have keeps nothing.** One type then means two things, and the check that catches a source that keeps a group the diff never saw is lost. This option was rejected.
- **The source keeps the keys of each page in its own state.** The same keys are then in two places, as ADR 0004 rejected for fingerprints. This option was rejected.
- **A failed group of its own.** This option was selected.

## Consequences

- A source can give a failed group for each input that it could not read, also an input that no scan read before.
- A failed group keeps its records for as long as the source gives it. The source stops giving it when the input is read again, or when the source knows the input is gone.
