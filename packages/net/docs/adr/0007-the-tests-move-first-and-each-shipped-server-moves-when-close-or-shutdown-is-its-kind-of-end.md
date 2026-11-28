# The tests move first, and each shipped server moves when close or shutdown is its kind of end

Status: Accepted 2026-11-28 (backlog #6078). Ezz approved the paper of 028f631b as written.

Decision-makers: Ezz, on 2026-11-28. The record says: "the 5 shipped servers move LATER (tests first; each moves when close/shutdown matches its kind of end)". The zukhruf session of backlog #6078 made the map below (session f0478ea1, kept in `~/.claude/plans/test-primitives-6078/map.txt`).

## Decision

**Now**, in the release of the package and its first consumer commits:

| Copy                                                                                                     | Its users                                                            | It becomes                                                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| testing `src/http/http-server.ts:29` `HttpServer`                                                        | 106 files in 8 repositories                                          | `HttpServer` of `@zukhruf/net/http`                                     |
| docker `src/testing/fake-engine.ts:53` `fakeEngine`                                                      | 12 docker test files                                                 | an `HttpServer` on a `PipeEndpoint`                                     |
| ssh `src/testing/silent-server.ts:5` `startSilentServer`                                                 | `client.test.ts`, `config-dial-route.test.ts`, `config-dial.test.ts` | `new Server(() => {}).serve(new TcpEndpoint())`                         |
| mutex `src/testing/stand-in-server.ts:5` `standInServer`                                                 | 6 mutex test files                                                   | a `Server` on a `PipeEndpoint` with a rooted name                       |
| single-flight `src/testing/stand-in-server.ts:5` `standInServer`                                         | 3 single-flight test files                                           | the same                                                                |
| ssh `control.test.ts:82-104` and `owner-death.test.ts:97-105` `listen`                                   | their own file                                                       | a `Server` with `allowHalfOpen`, on a `TcpEndpoint` or a `PipeEndpoint` |
| `portOf`, 13 copies: docker `sshd.ts`, ssh (10), testing `sshd.ts`, tools/eslint-rules `repoint.test.ts` | their own file                                                       | `serving.address.port`                                                  |

**Later**:

- testing `src/testing/engine-proxy.ts:58` `EngineProxy`, after the HTTP view works on a pipe.
- The 5 shipped servers, each when `close()` or `shutdown()` is its kind of end: mutex `lock-server.ts:177-185` (destroy, so `close()`), election `sqlite/leader-pipe.ts:65-69` (destroy, so `close()`), single-flight `coordinator/flight-server.ts:93-97` (`destroySoon`, an end after the flush), ssh `control/control-master.ts:30-58` (destroy), ssh `control/shared-connection.ts:262,303+` (`MasterConnection` drains). The servers of mutex and single-flight also need `unref()`.

**Never**:

- nx `src/generators/pair/generator.ts:23` `portOf`: it reads the port of an Nx tree, which is another concept.
- `sshdScript` and `dropWhenQuiet` of testing `reaper.integration.test.ts:2888,2911` and mutex `docker-engine-store.test.ts:126,149`: a shell script in a container, not a server of Node.js.
- The protocol fakes `sshd.ts` and `ssh-client.ts` of ssh, docker and testing: only their `portOf` moves.

The copies that inject faults (mutex `proxyTo`, testing `slowProxy`, mutex `vanishingHop`, elt's relays) move to `@zukhruf/chaos`, which has its own map.

## Considered Options

- **Move the shipped servers in the same release.** single-flight ends each connection after the flush, and ssh's master drains. Neither is `close()` or `shutdown()` today, and a change of their end is a change of their behavior.
- **Tests first, shipped servers when their end matches.** This option was selected.

## Consequences

- Each consumer moves after the release, and only then (the release flow of root ADRs 0007 to 0009). Each repository other than zukhruf gets one migration item.
- Each copy goes with its row of the copy ledgers.
