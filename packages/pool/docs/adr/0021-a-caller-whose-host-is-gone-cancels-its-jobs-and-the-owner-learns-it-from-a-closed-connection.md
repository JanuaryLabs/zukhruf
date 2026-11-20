# A caller whose host is gone cancels its jobs, and the owner learns it from a closed connection

Status: Accepted 2026-11-20 (backlog #3527). Built (2026-11-20), on one computer: each `Pool` of a standard kind serves its pipe from its construction to its disposal, rather than only while a `run` waits, so the pipe needs no state that a lazy start would add; a pipe across computers waits for ADR 0025.

A caller's abort cancels its job ([ADR 0020](./0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md)). A host can also end with no abort: a crash, a `SIGKILL`, or a chat server that ends when its chat closes. Its jobs stay in the store, the owner runs them, and nobody reads the output (map ticket 15):

- For OCR, the run is wasted work.
- elt's transcription writes a temporary wav and removes it when the caller's scope ends (`local-transcription-model.ts:60-86`). After a crash the file stays, and after an abort it is gone. Either way nobody waits for the job.

How the leading systems learn that a caller is gone (research 15, A):

| System                                   | Who learns that the caller is gone                 | A job that runs                                |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| gRPC                                     | the server, by the deadline or a closed connection | the handler gets a cancel and must stop itself |
| RabbitMQ `reply_to`                      | the broker, by the closed connection               | runs on; its reply is dropped                  |
| Celery, Temporal, BullMQ, pg-boss, Azure | nobody; the caller must cancel                     | runs on                                        |

No system has a heartbeat of the caller.

## Decision

From map ticket 15, resolved 2026-11-14 by the session from precedent. The address was decided on 2026-11-16 by the leaders (Ezz: "I trust your recommendation ... follow the top performers"):

- **The caller's address rides on each job of a `run`**, in the pool's envelope: the return address of a request-reply, as RabbitMQ's `reply_to` and the Return Address of Enterprise Integration Patterns.
- **The address is a pipe of the `Pool`.** While a `Pool` has a waiting `run`, it serves a pipe of [`@zukhruf/pipes`](../../../pipes/README.md) (`PipeEndpoint`) and writes its `PipeAddress` on each job of a `run`. gRPC learns of a gone client from the connection of the call itself, not from a second channel. `@zukhruf/sqlite-notify` does not change. The other option was the address of the notify's own listener: it changes the API of `@zukhruf/sqlite-notify`, and Postgres names a listening session by its process id, not by an address.
- **Only a `run` that waits has a caller.** A job that `start` sent carries no address, as a Temporal workflow outlives its starter ([ADR 0026](./0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)). The owner runs it to its end, or until `cancel()`.
- **A caller whose host is gone is a cancel, learned from a closed connection**, as gRPC cancels the server's context when the client's connection closes.
  - Before the owner starts a job, it connects to the caller's address. A refused connect means that the caller is gone.
  - While the job runs, the owner keeps that connection. Its `close` comes 1.6 to 3.7 ms after the caller's program dies (research 20a P1).
- **What the cancel does** follows ADR 0020. A job that cannot be shared is cancelled in the store, and its worker is killed if it runs. A shared job runs to its end: one caller that is gone is one caller that left.
- No deadline at the send. The closed connection covers a caller that died, and the caller's signal covers a caller that gives up.
- **Retention is pg-boss's**, unchanged, because the queue is one-to-one with it. A job that never starts is deleted after 14 days (`retentionSeconds`). A settled job is deleted after 7 days (`deleteAfterSeconds`). A sweep runs at most once a day. An output that nobody read stays for those 7 days. A `JobHandle` can read it until then, so this retention is part of the API (ADR 0026).

## Consequences

- A `Pool` of a standard kind keeps one more socket, from its construction to its disposal: `/tmp/zukhruf-pool-<uid>/<id>` on macOS and Linux, through the default folder of `@zukhruf/pipes`. The `<id>` is random for each `Pool`. The prefix `zukhruf-pool` is a name of this package, after `zukhruf-testing`.
- Disposal of a `Pool` closes its pipe and its connections. The owner sees each close as a cancel, which is the cancel of disposal ([ADR 0013](./0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)).
- Across computers a pipe is not an address that another computer can reach. That part waits for a second computer ([ADR 0025](./0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)).
- With a crash of a host, the transcription of its temporary wav is cancelled. An abort cancels it before the file goes ([ADR 0020](./0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md)).
- pg-boss has a deadline for the start of a job, `retentionSeconds`, but it is coarse (a daily sweep), `fetch` ignores it, and it deletes the row with no state. The pool does not use it as a cancel.
