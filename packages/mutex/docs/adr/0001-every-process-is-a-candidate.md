# Every process is a candidate

The socket lock store needs one coordinator for all processes on a host. We do not run a separate server for it. Each process that uses the socket lock store is a candidate, and the first one that needs a key when no leader exists wins the election and becomes the coordinator. We selected this because it needs no setup, and because the failover path (reassert and grace window) must work anyway.

## Considered Options

- **An explicit server that you start.** This is simpler and has fewer failovers. But each deployment must start, watch, and restart one more process.
- **A daemon that the first client starts.** This needs no setup. But it adds a hidden process, a log file, an idle timeout, and a race when two clients start it at the same time.

## Consequences

When the leader process stops, a failover occurs, even when it stops normally. The leader does not stay alive only to serve other processes. Thus the reassert and grace window paths run often, and the tests use them.
