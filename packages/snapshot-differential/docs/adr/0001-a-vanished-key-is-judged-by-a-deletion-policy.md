# A vanished key is judged by a deletion policy

> The place of the package is superseded by [ADR 0003](./0003-the-differential-is-a-zukhruf-package.md): the package moved to zukhruf.

An ELT pipeline loads 19 sources whose upstream has no change log. Each source gives a complete scan to a snapshot diff, which compares it with the snapshot of the last committed scan. Two kinds of upstream do not list every record that still exists:

- An upstream with a time to live drops old records with no deletion. macOS keeps activity for 28 days, and Safari keeps history for its configured age. A record that it dropped never comes back.
- A cache holds only part of its records. The Slack and Microsoft Teams apps load stretches of each conversation and drop them later. A dropped stretch can come back.

The diff had one option for both: a `covers` predicate. A vanished key that the scan did not cover left the snapshot with no delete. That is correct for a time to live. It is not correct for a cache. Teams drops a thread from its cache. A reply in the thread is deleted. Teams loads the thread again. The scan covers the reply now, but the snapshot does not have its key any more, so no scan deletes its row.

## Decision

Each vanished key gets a verdict from a deletion policy, which is a Strategy (Gamma et al., also named Policy):

- `deleted`, the closed-world assumption (Reiter, 1978): the diff yields a delete.
- `unknown`, the open-world assumption: the key stays in the snapshot, and the policy judges it again at the next scan.
- `expired`, a time to live: the key leaves the snapshot, and the diff yields no delete.

The package gives `ClosedWorld`, `Retention(horizon)` and `Coverage(covers)`. A source writes its own subclass for a different judgment. A diff takes no default policy, so each caller names its assumption.

The differential is a package of its own, with no dependency on the pipeline. The engine of the pipeline never calls it: only sources call it. The pipeline keeps a thin adapter, which gives the differential the stream's primary key, its key encoding and its `expiresBy` field, and turns each change into a message of the pipeline. A stream that emits no deletions takes no policy: the adapter judges each of its vanished keys expired. The package stays in the repository of the pipeline until a second repository needs it. Then it can move to zukhruf as it is.

## Considered Options

- **Keep `covers`, and add a second predicate for expiry.** Two predicates and their order decide one verdict. A third kind of upstream would need a third predicate.
- **One function that returns the verdict.** It is shorter, but a policy then has no name and no file, and a reader cannot find the assumption that a source makes.
- **A deletion policy class with three verdicts.** This option was selected.
- **Keep the differential in the pipeline.** The engine of the pipeline does not use it, and the code that knows the meaning of a vanished key has no concept of the pipeline in it.
- **Move the differential to zukhruf now.** No repository other than the pipeline's uses it, and each fix would then need a release and a version change there.

## Consequences

- The policy is required for each stream that emits deletions. The 14 sources that list every record give `new ClosedWorld()`.
- The snapshot keeps each unknown key. It grows with the records that the upstream holds no more and that no scan can judge. Each such key is also a row that the destination keeps.
- A record that comes back unchanged, after its key was unknown, gets no upsert. Before, it loaded as a new record.
- The saved state of `diff` has the same shape as before. The saved state of `diffGroups` has an `unknown` object only when there is an unknown key.
- The pipeline exports no `expiredAfter`, `covers` or `VanishedRecord` any more. Sources import the policies from this package.
- Airbyte has no equivalent: outside change data capture, it deletes only when it replaces a complete stream.
