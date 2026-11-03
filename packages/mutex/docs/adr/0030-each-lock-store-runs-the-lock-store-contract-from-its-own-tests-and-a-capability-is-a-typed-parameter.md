# Each lock store runs the lock-store contract from its own tests, and a capability is a typed parameter

The tests of the lock stores had one table, `src/testing/store-cases.ts`. It imported each lock store and each database driver, and the shared suites looped over it. The test file of a lock store had no way to call the shared tests. Thus the test files of SQL Server, MySQL and MariaDB copied the shared tests when they were written (`e4bc936e`), three seconds before their rows came into the table (`d4c6440c`). The copies drifted: the same claim waited 300 ms in one file and 5 s in another. A new lock store also had nothing that told it which tests of a session apply to it.

Now each lock store runs the lock-store contract from its own tests:

- `src/testing/contract/` has the contract: one function for each group of claims. `lockStore` is for each lock store. `durableTokens`, `looksTakeNoToken`, `processes`, `threads`, `onDisk`, `passiveLooks`, `leaseLoss`, `sessions` and `pools` are for the lock stores that have the capability.
- `src/testing/subjects/<store>.ts` has the subject of one lock store: how a test makes its fixture, opens a store over it, and opens it in a child process or in a worker thread. It also has the capabilities of the store, and the knowledge of its server that the tests need: how to end a session, how to see a session that waits, and how to cut the network. A child imports the module of the subject. It does not find the store by its name.
- `src/lock-stores/<folder>/<store>.contract.test.ts` calls each contract function that the store can run. The other test files of the store keep only the rules of that store.

A capability is a typed parameter, not a flag. `processes(subject, sharing)` needs a `SharedByProcesses`. Only a store whose child processes share its locks makes one, with `sharesWithProcesses`. Thus a call for a store without that capability does not compile. The same is true for `SharedByThreads`, `OnDisk`, `Partitionable`, `SessionControl` and `PoolControl`. When a store does not call a contract function, a comment beside its calls tells why. No test skips a store by its name.

The industry name of this structure is a contract test (J. B. Rainsberger, "Getting Started with Contract Tests", 2017). Rust `object_store` (`put_get_delete_list(&store)`), `abstract-level` (`suite({ factory })`) and Go (`nettest.TestConn`, `fstest.TestFS`) use it: the test of each implementation calls the shared tests and gives them a factory.

## Considered Options

- **Keep the table, and add columns for the session tests, or add a second table for the session stores.** The table would then hold hooks for tests, not facts about the stores. Each new claim would add a column that some rows fill and the other rows leave empty.
- **A list of flags, as the `supports` of `abstract-level`.** A store could set a flag and give nothing. A typed parameter tells that the store has the capability and gives what the test needs, in one value.
- **Keep the shared claims in the test file of each store.** This was the state before. Five copies of the heartbeat test drifted.

## Consequences

- To add a lock store, write its subject in `src/testing/subjects/` and a `<store>.contract.test.ts` that calls each contract function that its capabilities allow. The [recipe](../recipes/write-your-own-lock-store.md#test-your-lock-store) shows how.
- Each claim is in one place, so a fix to a claim is one fix.
- `src/testing/store-cases.ts`, `createChildStore` and `createThreadStore` are deleted. The global setup of the mutex, which started the database servers before the run, is deleted too. No test of the mutex sets a time limit below the default of `@zukhruf/nx/test` (240 s), and that default is longer than each start of a server (Postgres 60 s, MySQL and MariaDB 90 s, SQL Server 180 s).
- A test that waits for a server, for the engine or for a process waits for the fact. Its limit only finds a fact that does not come (backlog #3476).
- `node --test` runs the contract of each store in a file of its own, so the stores run in parallel.
