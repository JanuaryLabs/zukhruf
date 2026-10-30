# Code copied from the event-detection eval

The eval of this package and the eval of `@zukhruf/event-detection` (`packages/information-filtering/event-detection/eval`) both score a frozen design of a package on labelled sets, with roles, frozen label hashes and one exam. This eval keeps its own copy of that knowledge, and does not share it yet.

The reason is the Rule of Three (workspace ADR 0001, rule 2). This is the second place. A third eval of a frozen design starts the extraction, and the three working copies then give the boundary of the shared code (backlog #3261). Until then, make each fix in both copies, and name both files in the commit.

Paths on the left are in `packages/information-filtering/event-detection/eval`. Paths on the right are in `packages/information-filtering/relevance-filtering/eval`.

## Copied without changes

- `roles.ts` → `roles.ts`: the roles training, regression and exam, and the rule that scores an exam one time only.
- `roles.test.ts` → `roles.test.ts`.

## Copied with changes

**`answer-key.ts` → `answer-key.ts`.**
Both read `set.json` first, so an exam that the run does not score is not opened, and both refuse labels whose hash is not the hash of `set.json`.
Changes: the labels are the frozen research files, so the hash is the sha256 of the file bytes, one for each label file, and not of the JSON of the rows. A row has labels for 16 profiles, not an event. The text of an article comes from the cache, not from a text source.

**`verdict.ts` → `verdict.ts`.**
Both apply the exam verdict rule of the frozen plan to the first and only score of an exam.
Changes: the rule is that of `freeze-ranking/plan.json`: non-inferiority to the typed keyword list (margin 0.05 MAP), and intervals above 0 against the broad keyword list and newest first. It has no "inconclusive" result and no regression sets.

**`bootstrap.ts` → `bootstrap.ts`.**
Both give a 95% percentile interval of a paired difference with a fixed seed.
Changes: the units are profiles (the topic bootstrap of the research) or exam articles in two strata, not blocks of gold events. The statistic of an article replicate is the MAP, with each article in as many ranks as its weight. The generator is numpy's (`numpy-random.ts`), not Mulberry32, because the research rounds and the exam rule name `numpy.random.default_rng`.

**`run.ts` → `run.ts`.**
Both are the command line runner: `parseArgs`, a usage text, a decision of the role of each set, and a results folder.
Changes: the commands are `check`, `slices`, `ranking`, `rehearse` and `--exam`. There is no scoreboard and no `--accept`: the design is frozen, so there is no accepted design to compare with.

## Not copied

The scoreboard, the pins, the accepted events, the text sources, the probes and the coreference metrics. They are about the partitions of event detection or about a live model, and this eval has neither.

## Backlog

#3261 waits for a third consumer. Its interim rule: mirror every fix in both copies, and name both files in the commit.
