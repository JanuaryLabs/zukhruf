# A joiner follows its flight record without acquiring the key

> Superseded by [ADR 0003](./0003-a-caller-leads-or-joins-in-one-request-to-an-elected-coordinator.md): a caller now leads or joins in one request to an elected coordinator, and there are no flight records.

A second `sync` must not fail when a sync runs. It must join the flight and report its outcome. A joiner in another process must learn two facts: when the flight ends, and its outcome. The lock store knows neither fact. A busy key does not prove that a flight runs: `LockCoordinator` answers "busy" to each attempt during its grace window, and `SqliteStore` answers "busy" while a caller in the same process waits in line. A key that is free does not tell the outcome. Thus the leader writes a flight record before it runs the work, and it writes the outcome into the record when the work ends. A joiner **follows** the record: it reads the record until the flight has an outcome. It uses a [holder check](../../../mutex/docs/adr/0015-a-holder-check-never-acquires-the-key.md) only to learn whether a running flight still has a holder. The joiner never acquires the key.

## Considered Options

- **Wait for the key with the acquire mode wait, then read the outcome.** The joiner becomes a waiter. When the flight ends, the lock store grants the key to the joiner. Another caller that tries the key at that time finds it busy and gives up. That is the problem that a join must solve. Also, the joiner holds the key for no work.
- **Do holder checks until the key is free.** Flights that follow each other can keep the key held at each check. Then the joiner waits as long as the flights continue, and it can wait forever. A free key also does not tell the outcome.
- **A fourth lock store operation that resolves when the key is free.** No lock store has a release event today. A new operation breaks each lock store that a user wrote, and it still does not carry the outcome.
- **Read the flight record. Use the holder check only to find a holder that stopped.** This option was selected.

## Consequences

- `SharedFlight` needs records, which the `FlightRecords` interface defines. `FileFlightRecords` keeps one JSON file for each key. A user can keep the records in another place, for example a table of the database that the work changes.
- Only the holder of the key writes the records of the key. Joiners only read them, so they never make the key busy.
- A flight whose holder stopped stays "running" in its record. The next holder closes it as interrupted, and its new flight is the successor. A joiner of the closed flight continues with the successor. A joiner that saw the holder of a running flight and then finds no holder rejects with `FlightInterruptedError`. A joiner that never saw a holder tries to lead.
- A joiner reads the record once in each poll interval. The outcome of a flight must stay readable after newer flights began, so the records keep it for a keep window, not for the last N flights. A joiner that reads after the keep window rejects with `FlightOutcomeLostError`.
- The value travels as JSON. `parse` turns it into the type of the value, and the leader gets the parsed value too, so all callers get one shape.
