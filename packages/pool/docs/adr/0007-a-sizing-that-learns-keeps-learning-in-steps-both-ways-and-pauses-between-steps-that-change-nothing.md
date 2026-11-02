# A sizing that learns keeps learning in steps both ways, and pauses between steps that change nothing

`HillClimbing` and `Gradient` learned once ([ADR 0002](./0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md)). They started with two workers, added one more worker while it paid, and then stopped. A pool in a long-lived server then kept its first size. When the jobs got heavier, when they got lighter, or when other processes took the memory, the size did not change.

Production systems that size their workers do not stop:

| System                                | After it finds a size                                                                                                         | How it gets smaller                                                                     | Source                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| .NET thread pool, hill climbing       | changes the thread count in a wave at random intervals of 10 to 200 ms, and never stops                                       | its move can be negative; an idle thread exits after 20 s                               | `PortableThreadPool.HillClimbing.cs:280-288,366-369`, `PortableThreadPool.cs:55` (dotnet/runtime `76198de`) |
| Netflix concurrency-limits            | `Gradient2Limit` lets its base time decay; `GradientLimit` and `VegasLimit` measure the base time again at jittered intervals | multiplies the limit by 0.5 to 0.9                                                      | `Gradient2Limit.java:291-310`, `GradientLimit.java:261-283`, `VegasLimit.java:239-262` (`78a74b9`)          |
| Envoy adaptive concurrency            | measures its minimum round trip again at `min_concurrency`, with jitter                                                       | the gradient times the limit, plus headroom                                             | `adaptive_concurrency_filter.rst`, `gradient_controller.cc:194-199,288`                                     |
| Akka `OptimalSizeExploringResizer`    | a 40% chance each 5 s to try a near size, only while every routee is busy                                                     | to 0.8 times its highest use after 72 h of less use                                     | `OptimalSizeExploringResizer.scala:89-108,270-298`, `reference.conf:287-337` (`838fe72`)                    |
| Kubernetes HPA                        | computes the size again at each tick                                                                                          | uses the highest size of the last 300 s                                                 | `horizontal-pod-autoscale.md`                                                                               |
| Ray Serve, whose replicas load models | computes the size again at each tick                                                                                          | waits `downscale_delay_s`, 600 s: "if your application initializes slowly", increase it | `advanced-autoscaling.md:67-91`, `autoscaling_policy.py:68-148` (`541bd56`)                                 |

The systems whose workers are costly to start (the HPA, Ray Serve) add a worker fast and remove one slowly. None of them stops a worker to measure fewer. Envoy does, and its documentation warns of more 503 answers while it measures.

## Decision

- A sizing that learns takes steps for as long as the pool runs. Each step measures in the order A, B, A, as before. B is one more worker, or fewer workers.
- A step with fewer runs fewer workers and keeps every worker alive: `kept` stays the size. The step costs the throughput of one window, not a warm-up. `HillClimbing` tries one fewer. `Gradient` tries two, because its test compares the time of a job with the time with two workers. Only a window at two measures that time again with the jobs of now, as `GradientLimit` and Envoy measure their base time again at their least concurrency.
- The sizing keeps one more worker as soon as one step shows that it pays. It lets its last worker go only after two steps in a row show that the worker does not pay, as the HPA holds its highest recent size and Ray Serve restarts its delay when the direction changes. Both directions use one test: for `HillClimbing`, the last worker adds at least a tenth more jobs a second; for `Gradient`, a job takes at most half again its time with two.
- A step that changes the size leads to the next step in the same direction at once. Any other step turns around after a pause. The pause starts at one window and doubles after each step in a row that changes nothing, up to 16 windows, as the .NET hill climbing waits up to ten times longer when more threads hurt: each step with one more worker that does not pay starts a worker for nothing. The length of the pause is random, 0.5 to 1.5 times, so pools in other processes do not step together (.NET; AWS, "Exponential Backoff And Jitter").
- The sizing reads the capacity again after each window. When the workers it keeps do not fit, it runs fewer at once: memory that other processes took does not wait for two steps. The ceiling stays the capacity when the pool was built, because the pool makes its slots then.
- Only a sizing whose ceiling is 1 stops. A sizing that has no step that fits measures again after the next window.

## Considered Options

- **A new class next to the two that learn once.** No production system stops learning, and no host needs a sizing that does. The package does not keep an old behavior next to a new one.
- **The wave of the .NET thread pool.** ADR 0002 rejected it: it is much more code, and it changes the size all the time, so it starts workers that warm up for nothing.
- **A base time that decays, as `Gradient2Limit` does, for `Gradient`.** It never measures at two workers. A lasting slowdown becomes the new normal, so the pool does not get smaller when the jobs get heavier.
- **`Gradient` with one fewer worker, as `HillClimbing`.** A step that compares n with n − 1 measures only the last worker, and the time with two stays from older jobs. In a test, an engine that the jobs share went from 4 units to 2. `Gradient` at 6 workers saw 1.5 times the time with two, but the true slowdown was 3 times, and the pool did not get smaller.

## Consequences

- A pool under steady jobs starts a worker to try one more less and less often: at most about once each one to two minutes after a few steps, and never two at the same moment as an identical pool in another process.
- A step with fewer runs fewer workers for one window. For `Gradient` it runs two workers, so the cost grows with the size.
- The tests run real pools with real worker processes on the real clock. A window is 2 seconds, so the tests of the pool take about 5 minutes. The tests that only wait run at the same time. The tests that replace what the whole process reads, or measure timing, run alone.
