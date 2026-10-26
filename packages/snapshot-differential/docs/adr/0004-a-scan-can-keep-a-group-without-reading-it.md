# A scan can keep a group without reading it

The elt web source crawls websites with a revisit policy. The policy requests a page again only when the page is due: an archive page from 2009 is due every 14 days, not on every crawl. A page that is not due has no response. The source therefore cannot give a fingerprint for it, and `diffGroups` did not keep a group without a matching fingerprint. The page was not in the scan, so its group left the snapshot. When the page was due again, the diff read it as a new group, and the source extracted the page again.

The source cannot read the saved fingerprint: the snapshot is the state of the diff, and its shape belongs to this package. A file scan has the same need: when FSEvents tells the scan which files changed, the scan knows that each other file is unchanged without reading the file or its size.

## Decision

`diffGroups` takes a kept group, `{ key, kept: true }`, in place of a group:

- The diff copies the saved fingerprint and records of the group into the new snapshot. It does not read the group, and it yields no change for it.
- In a scan in parts, a kept group is listed, so the last part does not judge its keys.
- A kept group that the snapshot does not have is an error. The source vouches for a group that the diff never saw.

## Considered Options

- **The source saves the fingerprint of each group again in its own state.** It works with no change to this package, but the same fingerprints are then in two places, and the state that the source saves after each part is larger.
- **The source never ends the scan.** Every call uses `continues`, so no group leaves the snapshot. A group whose input is gone then never leaves the snapshot, and the open scan saves a `listed` key for each group. `continues` is for a scan in parts, not for a scan that never ends.
- **A kept group in the differential.** This option was selected.

## Consequences

- A kept group costs no read and no fingerprint.
- The diff trusts the source. If the input of a kept group changed, the diff does not see the change until a scan reads the group again.
