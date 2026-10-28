# An eager pool backs off before it replaces a worker that exited early

An eager pool replaced an idle worker at once when it exited. A worker can exit again at once: the program is missing, or it cannot load its model file. A worker without `ready()` is ready when it starts, so the pool started it again without end. A probe of one slot counted 2,331 starts in one second for a missing program, and 12 starts each second for a process that exits at once.

Now an early exit puts the slot in a back-off. An early exit is the exit of a worker that ran less than 10 minutes. The pool waits 1 s after the first early exit in a row, and doubles the wait after each next one, up to 60 s. A worker that runs 10 minutes ends the back-off: the pool replaces it at once when it exits. Kubernetes restarts a container in CrashLoopBackOff with the same rule. KEP-4603 tunes its wait to start at 1 s and to stop at 60 s, and Kubernetes resets it after 10 minutes. PM2 also doubles its wait between restarts, and resets it when the process runs long enough.

The numbers are constants, not options. A host does not choose them, as a pod does not choose the wait of Kubernetes.

The pool does not give up after many early exits, as systemd does after `StartLimitBurst`. Jobs come later and need workers. A job that needs a slot in a back-off does not wait: its worker starts now, and the job gets the exit of that worker. Thus jobs set how often a worker starts, and each failure goes to the job that caused it.

Disposal clears the timer of each back-off, so that the process of the host can end at once.
