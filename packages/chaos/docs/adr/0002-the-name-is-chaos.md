# The name is chaos

Status: Proposed 2026-11-28 (backlog #6078).

Decision-makers: Ezz, on 2026-11-28. The record says: "the tool package is @zukhruf/chaos". The step 2 draft had proposed `@zukhruf/fault-injection`, after Polly Simmy's term, with `chaos` as the alternative.

| Source                                                            | Word                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Principles of Chaos Engineering](https://principlesofchaos.org/) | "Chaos Engineering is the discipline of experimenting on a system in order to build confidence in the system's capability to withstand turbulent conditions in production." |
| [Polly Simmy](https://www.pollydocs.org/chaos/)                   | chaos strategies (fault, outcome, latency, behavior) of a resilience pipeline                                                                                               |
| [Toxiproxy](https://github.com/Shopify/toxiproxy)                 | a TCP proxy that simulates network conditions for tests                                                                                                                     |

## Decision

- The package is `@zukhruf/chaos`, in `packages/chaos`. The word is the industry's word for the field, and a noun of one word, as `net` and `process` are.
- No name of the package or of its code is the name of Toxiproxy, the reference that it ports. The classes of the toxics take Toxiproxy's names for them (`Latency`, `Timeout`, `ResetPeer`, `Slicer`), as Ezz ruled on 2026-11-28 ("Toxiproxy names"), and so do the words `proxy`, `toxic`, `upstream` and `downstream`. The README cites each one.

## Considered Options

- **`@zukhruf/fault-injection`, after Polly Simmy.** It names the act. Ezz chose `chaos`.
- **`@zukhruf/toxiproxy`.** It names the reference that the package ports, which the repository forbids.
- **`@zukhruf/chaos`.** This option was selected.
