# Event grouping

Many sources report one real occurrence, and a reader wants to see it one time. This package puts the reports of one real occurrence into one event. It compares the leads of reports by their vectors and by their numbers, and it clusters the reports of the last 7 days again on each new publish day.

Before you change a parameter, run `nx run event-grouping:eval` ([eval/README.md](./eval/README.md)).

## Language

**Report**:
An id, a title, a body, a publish date and, when the caller knows it, a publisher. The caller gives them. A news article is one example.
_Avoid_: Article, document, item

**Publisher**:
The name of the source that published a report, for example the host of its site. Two reports have the same publisher only when both have a publisher and the names are equal.
_Avoid_: Source (for the publisher), outlet, site

**Event**:
One real occurrence at one time and place, and the reports that the detector put into it. Two lawsuits by one company are two events.
_Avoid_: Story, topic, cluster (for the result)

**Event id**:
A number that names an event. The detector never gives an event id to a second event.
_Avoid_: Cluster id, group id

**Lead**:
The title and the first two real sentences of the body of a report.
_Avoid_: Summary, snippet, excerpt

**Real sentence**:
A sentence with at least 5 words, mostly letters, and with URLs in at most half of its characters. A URL line, a byline or a caption is not a real sentence.
_Avoid_: Segment (for the result)

**Headline-only report**:
A report with no real sentence after its title. A paywall preview and a description-only page are examples. A headline-only report is always alone in its event.
_Avoid_: Empty report, title-only

**Vectors**:
The port that keeps one vector for the lead of each report, and gives the neighbours and the similarity of reports. The `Collection` of `@zukhruf/embeddings` is one implementation.
_Avoid_: Index, store, embeddings (for the port)

**Similarity**:
The cosine of the vectors of two leads.
_Avoid_: Distance, score

**Pair score**:
The probability, from 0 to 1, that two reports report one event. It comes from the similarity, the numbers and the publishers of the two reports. Two reports of one publisher get a lower pair score.
_Avoid_: Similarity, confidence

**Threshold**:
The pair score at which two reports report one event: 0.5.
_Avoid_: Cut-off, limit

**Shortlist**:
The 80 nearest reports of a report, by similarity, from the reports that have an event and are inside the window. Only these reports become pairs. The standard term is blocking.
_Avoid_: Candidates, neighbours (for the result)

**Publish day**:
The UTC calendar day of the publish date. The window and the clustering count in publish days.
_Avoid_: Date (for the day)

**Window**:
The reports whose publish day is at most 7 days before or after the publish day of a report.
_Avoid_: Range, period

**Clustering**:
Group-average clustering of the reports with a lead in the window that ends on the latest publish day. The detector does it when a report of a new publish day arrives.
_Avoid_: Batch, re-index, merge

**Online assignment**:
The step that gives a report an event when it arrives: the event of its shortlist with the highest mean pair score over all its members, at or above the threshold.
_Avoid_: Placement, matching

**Overlap**:
The number of reports that a new cluster and an old event have in common. An old event id goes to the new cluster with the largest overlap.
_Avoid_: Intersection, match
