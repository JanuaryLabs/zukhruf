# A sizing that learns compares one more worker between two windows

`HillClimbing` and `Gradient` find how many workers pay. They measure jobs at one number of workers, then at one more. The jobs do not stay the same while they measure: OCR reads the files of an import in the order of their names, and these come grouped by kind, small stickers first, photos later. On 2026-10-26, 724 WhatsApp images were read on one computer. Two workers measured 36 images a second on stickers, three workers measured 40 on photos, and the sizing kept two workers in 3 of 3 runs. Pools of a fixed size read the same images in 36 s with two workers and in 20 s with three.

Thus each step measures in the order A, B, A: a window at the number that pays so far, one at one more, and one at the first number again. The step compares the window with one more to the mean of both other windows. A change of the jobs that is slow and steady cancels. The worker that the step tries stays alive during the last window, so the next step needs no new warm-up. With this order, 3 of 3 runs grew to the capacity of the computer (5, 4 and 5 workers). A window has at least 20 jobs and 2 seconds, so the size of a few files does not decide.

## Considered Options

- **A plain comparison, before and after.** It measured the jobs, not the workers, as above.
- **Weigh each job by its size.** It is exact, but each caller must give a weight with each job.
- **The wave of the .NET thread pool.** It changes the number of threads all the time, and separates their effect from the jobs with signal processing. It handles fast changes of the jobs too, but it is much more code.
