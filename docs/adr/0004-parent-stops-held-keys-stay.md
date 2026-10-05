# When the parent stops, held keys stay held

In the process tree reach, the parent process is the coordinator. When the parent stops, no coordinator is left, and no process can start a new one for the same children. Thus no other holder can get a key that a child holds. We decided that a child that holds a key keeps it, and that its release does not fail. A waiter gets `CoordinatorUnavailableError`, because no coordinator can grant its key.

## Considered Options

- **A lost lease for each holder.** The first plan gave `LockLostError` to each child that held a key. That error means "another holder may have your key", which is not true here. It would cause a false alarm.

## Consequences

`LockLostError` has one meaning for all lock stores: another holder may have the key now.
