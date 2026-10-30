# A headline-only report never joins another report

The pair score learned the similarity scale of title-and-lead vectors. Two titles alone have a higher similarity, and a title has few numbers to disagree. On the HLGD test set, which has titles only, the design of round #3130 joined almost all reports. B-cubed F0.5 was 0.284, against 0.819 for the baseline, with 6,326 false joins (backlog #3132, limitation 18 of the [workspace record](../../../../../docs/research/event-detection.md)).

A false join hides a report: the reader sees one event and does not see the other occurrence. A false split shows a duplicate. The maintainer chose F0.5 as the score, which counts precision two times as much as recall, because a false join is worse than a false split.

Thus a headline-only report gets a new event, and it never joins another event. The detector does not give it to the vectors port, so it is never in a shortlist, and no report can join its event. The clustering skips it.

## Considered Options

- **No guard.** Headline-only input gives large false events.
- **A second model trained on titles**, selected by the shape of the input. It needs a new research round.
- **A refusal**, as an error. A feed has headline-only reports, for example paywall previews. A refusal makes each caller remove them first, and the reader loses them.
- **Each headline-only report alone in its event.** This option was selected.

## Consequences

- A headline-only report never causes a false join.
- Each headline-only report of one occurrence is a duplicate for the reader.
- A report with one real sentence and no title is headline-only too: that sentence becomes its title.
