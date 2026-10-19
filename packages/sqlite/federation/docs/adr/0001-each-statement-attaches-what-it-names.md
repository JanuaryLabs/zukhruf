# Each statement attaches what it names

The first host of this package kept about 18 databases, one for each data source. Its rules must read them, and one SQLite connection can attach only 10. The first design attached a database when a statement first named it, and kept it attached. At the limit, it detached the database that it attached first.

That design has three problems:

- A statement that names 11 databases never ends. Each attach detaches a database that the same statement needs, so the statement fails again and attaches again.
- A database that stays attached can be stale. A host can move a database to a new folder and delete the old folder, for example when the user changes what a data source keeps. A probe on 2026-10-14 showed that an attached database continues to answer after its file is deleted.
- The handle must remember which databases it attached, and in which order.

An attach is cheap. A probe on 2026-10-14 measured 0.2 ms to 0.45 ms for each of 17 real databases, also for a file of 2.7 GB. Thus each statement attaches the databases that it names, and the handle detaches all of them when the statement ends. The handle asks the host where each database is for each statement.

## Considered Options

- **Keep databases attached, and detach the oldest at the limit.** This option has the three problems above.
- **Detach after each evaluation of the rules of the host.** The rule engine gives the same handle to each condition, and it does not tell the handle when an evaluation ends. The port of the rule engine would have to change.
- **Each condition declares its databases.** The handle attaches them before the evaluation. The author must keep the list and the SQL the same, and the rule engine has no place for the list.
- **Each statement attaches what it names, and detaches it at the end.** This option was selected.

## Consequences

- No database stays attached between two statements. Thus the handle holds no lock between statements, and the writers of other processes can commit.
- A condition with many statements attaches the same database many times. Each attach costs less than 1 ms.
- Each detach makes SQLite prepare the cached statements of the connection again. node:sqlite does this when a statement runs again.
- The host can move a database between two statements. The next statement reads the database from its new path.
