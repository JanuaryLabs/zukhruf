# A pool reports its stats as one snapshot of counts

A host must know if a worker can take a job, for example for a health check. Only the pool knows the state of each slot and the jobs in its queue. Thus `stats` gives four counts: the workers that start, the idle workers, the lent workers, and the jobs that wait for a worker. A worker that exited is in no count.

Mature pools report the same counts. Go's `database/sql` gives `DB.Stats()` with `InUse`, `Idle` and `WaitCount`. undici gives `pool.stats` with `free`, `queued` and `running`. HikariCP gives the active and idle connections and the threads that wait. Apache Commons Pool gives `getNumActive()`, `getNumIdle()` and `getNumWaiters()`. tarn gives `numUsed()`, `numFree()`, `numPendingAcquires()` and `numPendingCreates()`. All of them report idle, in use and waiting. tarn also reports the workers that start, and a pool whose workers warm up needs that count. The names come from this glossary: lent, not in use or borrowed.

`stats` leaves out a total, because it is the sum of three counts. It leaves out the maximum, because the sizing decides it. It leaves out counts since the pool started, because only Go gives them.

Each read makes a new object, as Go returns `DBStats` by value. The counts of one read agree with each other, and an object that a host keeps does not change later. undici's getters read the pool live instead, and two of them can disagree.
