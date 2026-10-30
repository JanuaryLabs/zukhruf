# Relevance filtering

A reader wants the new articles of a feed that are about an interest, and not the others. This package ranks the articles of a stream for a profile of the reader, the best first. A scorer gives a probability for each article, and a threshold that the host chooses turns the probabilities into a yes or no.

## Language

**Profile**:
An interest of the reader: a name, a description, optional keywords, and the answers that taught it. A profile is a value. It does no I/O, and the host stores it.
_Avoid_: Topic, query, filter (for the profile)

**Description**:
One sentence that says what the reader wants to read, for example "Cybersecurity: attacks, breaches, vulnerabilities and the tools that stop them."
_Avoid_: Query, prompt

**Scorer**:
A method that gives the probability of each article of a stream for a profile, and the ranking. The package has a similarity scorer and a decision scorer. The host decides when a scorer runs.
_Avoid_: Filter, classifier, judge

**Scores**:
What a scorer gives for one profile and one stream: the ranking and the probability of each article.
_Avoid_: Filter, result

**Decision model**:
A model that answers a typed question about a text with a calibrated probability, for example Liquid AI's d1-2B. The decision scorer asks it, through the AI SDK, if the main subject of the article is the description.
_Avoid_: LLM, judge, classifier

**Description vector**:
The vector of the description from the embedding model of the stored articles, made with the prompt that the model uses for a query. The caller makes it for the similarity scorer.
_Avoid_: Query embedding, profile vector

**Keyword**:
A word or a part of a word that the reader types. It matches at the start of a word, in any case. A regular expression can also be a keyword.
_Avoid_: Tag, term

**Answer**:
The yes (relevant) or no (not relevant) of the reader for one article that the reader saw. The answers are the taught articles.
_Avoid_: Label (for the reader's answer), feedback, rating

**Taught article**:
An article with an answer. The similarity scorer compares its similarity with the similarities of the stream.
_Avoid_: Training example, sample

**Stream**:
The articles that a scorer scores, for example the new articles of the feed since the last time. The similarity scorer fits its calibration on the similarities of the stream.
_Avoid_: Feed (for the articles to score), batch, corpus

**Similarity**:
The cosine of the vector of an article and the description vector.
_Avoid_: Score (for the cosine), distance

**Calibration**:
The step that makes a similarity a probability. The similarity scorer fits a binormal model on the stream and the taught similarities. When that fit cannot hold, it uses Platt's method on the taught similarities.
_Avoid_: Normalisation, scaling

**Binormal model**:
Two normal distributions of the similarities: one for the relevant articles and one for the others, with the share of relevant articles. The standard term is a score-distribution model (Manmatha et al. 2001; Arampatzis and van Hameren 2001).
_Avoid_: Mixture (alone), Gaussian

**Keyword evidence**:
The change of the probability of an article when it matches a keyword, or does not match, as naive Bayes computes it.
_Avoid_: Boost, bonus

**Probability**:
The chance, from 0 to 1, that an article is relevant to the profile. The similarity scorer calibrates it on the answers, and a decision model gives it. For a profile with no relevant answer, the similarity scorer gives 1 for a keyword match and 0 for the others, and that probability is not calibrated.
_Avoid_: Confidence, score

**Ranking**:
The articles of the stream, the best first. The reader shows the best N of each day. The standard term is routing (TREC).
_Avoid_: Sort, feed (for the ranking), score list

**Threshold**:
A rule that gives the lowest probability to accept. An expected-F threshold maximises the expected F-beta of the stream. An expected-utility threshold accepts when the expected cost of a miss is at least the expected cost of a false alarm.
_Avoid_: Cut-off, limit

**Accepted article**:
An article that a threshold accepts. The accepted articles come in the order of the ranking.
_Avoid_: Match, hit, positive
