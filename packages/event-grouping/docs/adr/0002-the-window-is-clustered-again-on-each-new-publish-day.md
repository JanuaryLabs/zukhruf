# The window is clustered again on each new publish day

A detector that decides when a report arrives cannot change that decision later. Then the same reports in a different arrival order give different events. Yang, Pierce and Carbonell (SIGIR 1998, "A study on retrospective and on-line event detection") show this for single-pass clustering. Research round #3130 measured four grouping steps. Group-average clustering of the 7-day window on each publish day had the best score and the same score in 10 arrival orders. Limitation 7 of the [workspace record](../../../../docs/research/event-grouping.md) has the numbers.

Thus the detector does two steps:

1. **Online assignment.** When a report arrives, it joins the event of its shortlist with the highest mean pair score over all members of that event, when that mean is at least the threshold. Equal means go to the lower event id. Otherwise the report starts a new event. These events are provisional.
2. **Clustering.** When the first report of a new publish day arrives, the detector first clusters the reports with a lead in the window that ends on the last publish day. It joins the reports of each connected component of the shortlist graph whose edges are at or above the threshold. Then it runs group-average clustering (`agnes`, method `average`) on each component, and cuts at a distance of 1 − threshold. Group average cannot join two components, so the result is the same as one clustering of the whole window.

## Event ids

A reader needs an event id that does not change when the detector clusters again. The detector carries the old ids forward by overlap. The largest overlaps choose first, and each old id goes to one cluster. Equal overlaps go to the lower old id, and then to the cluster whose component has the lowest report id. A cluster with no old id left gets a new id. The detector never uses an event id again.

The round broke the last tie by the row number of its corpus file. A stream has no row number, so the detector uses the report id. This tie can change events, not only ids: a report outside the window keeps its old id, so it stays with the cluster that gets that id. The conformance test gives each report an id that starts with its row number, and then finds 0 changed pairs.

## Publish days

The window and the clustering count in UTC publish days, as in the round. The detector gives the start of the publish day to the vectors port as the publish date. Thus `nearest(id, { k: 80, withinDays: 7 })` finds the reports of 7 publish days before or after, whatever the time of day.

## Considered Options

- **Online complete linkage**, as in round #3124. Its score changed with the arrival order.
- **Online group average.** Its score changed less, but it still changed.
- **Online group average with a merge step every 20 reports.** The same.
- **Online group average, and a clustering of the window on each new publish day.** This option was selected.

## Consequences

- The events of the latest publish day are provisional. They become final for that day when a report of a later publish day arrives. A quiet feed keeps them provisional until its next report.
- In one call to `add`, the detector sorts the reports by publish date. Equal publish dates keep the order of the array. A report of an older publish day joins by online assignment. It is clustered again only when it is inside the window of a later clustering.
- A clustering asks the vectors port for the shortlist of each report in the window. Its cost grows with the square of the window size. See limitation 21 in [the limitations](../limitations.md).
