# A test helper goes into an area when three repositories have its knowledge and it does not use `mock`

Root ADR 0001 (rule 2) keeps test helpers as copies, also after the third copy. On 2026-10-09 the maintainer chose a third copy of `recordDiskWrites` in the tests of `@zukhruf/fs`, in place of a new `fs` area. Thus each test file reads from top to bottom, and no area ships code that imports the `mock` of `node:test`.

On 2026-10-26 an inventory of 10 repositories found about 1,500 test helpers and fixtures in about 1,100 test files. Three helpers were in many repositories, and Node has no API that does their work:

- A temporary directory that retries its removal on Windows: about 200 places in 7 repositories.
- An environment scope: about 50 places in 5 repositories.
- A strict msw server: about 120 places in 4 repositories.

A copy in 7 repositories cannot get one fix in one commit. Thus the maintainer changed the rule on 2026-10-26.

## Decision

A test helper goes into an area of `@zukhruf/testing` when both conditions are true:

1. Three or more repositories have its knowledge. Count the places that do the same thing, as the Rule of Three does. Count knowledge, not lines: two helpers with different code that do the same job are two places.
2. It does not use the `mock` of `node:test`. Such a helper replaces a function of a module for one test, for example `statfs` of `node:fs/promises`. An area that ships it imports `node:test` into each consumer.

Each other test helper stays a copy in its test file. Examples are a helper that only one repository has, and a helper that uses `t.mock`. No package exports a shared test module for it. A ledger of the package records each copy: its places, what is the same, what differs, and why it stays. The ledgers are `docs/copied-code.md` and `docs/copied-from-*.md` of each package. They are the one complete list of the copies, and the clone check of the CI (backlog #3033) reads them as the copies that are allowed. A fix to one copy goes into each copy, and the commit names each file.

Before a helper goes into an area, do two checks. First, look for an API of Node that does the same work. A pattern that Node covers gets a lint rule, not a helper. Examples are `t.waitFor` in place of a poll loop, and `Array.fromAsync` in place of a loop that only collects. Second, write the area as a README before its code.

The inventory gave two areas: the temporary directory (`TemporaryFiles` of `@zukhruf/testing/fs`, [ADR 0008](./0008-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md)) and the msw interception (`@zukhruf/testing/msw`, [ADR 0010](./0010-the-msw-area-is-always-strict-and-records-each-request.md)). The environment scope met both conditions, but it was removed before its release ([ADR 0009](./0009-a-test-never-changes-the-environment-of-its-process.md)).

## Considered Options

- **Each test helper stays a copy** (the rule from 2026-10-09). A fix to the temporary directory must go into about 200 places in 7 repositories.
- **Each helper in three places goes into an area**, as the Rule of Three does for shipped code. Then areas ship `node:test` mocks, and they hold knowledge of one repository, for example the worker process of the mutex tests.
- **Three repositories, and no `mock`.** This option was selected.

## Consequences

- A test helper that only this repository has stays a copy, also in more than three places. Examples are `recordDiskWrites` and `mountAs` (they use `t.mock`), `LosableElection`, `connect` of the docker tests, and `hold` of the mutex tests.
- A copy that no ledger records fails the clone check of the CI. Thus each ledger lists each copy that stays, also a copy that a ledger earlier called "not counted".
- The docker package and the async package cannot import `@zukhruf/testing` in their tests, because the import makes a cycle in the build (root ADR 0001). Their copies stay, also when a helper meets both conditions.
