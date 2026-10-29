# Relevance filtering

A reader wants the new articles of a feed that are about an interest, and not the others. This package ranks the articles of a stream for a profile of the reader, the best first. It gives a probability for each article, and a yes/no decision that is not recommended.

## Language

**Profile**:
An interest of the reader: a name, a description, optional keywords, and the answers that taught it. A profile is a value. It does no I/O, and the host stores it.
_Avoid_: Topic, query, filter (for the profile)

**Description**:
One sentence that says what the reader wants to read, for example "Cybersecurity: attacks, breaches, vulnerabilities and the tools that stop them."
_Avoid_: Query, prompt

**Description vector**:
The vector of the description from the embedding model of the stored articles, made with the prompt that the model uses for a query. The caller makes it.
_Avoid_: Query embedding, profile vector

**Keyword**:
A word or a part of a word that the reader types. It matches at the start of a word, in any case. A regular expression can also be a keyword.
_Avoid_: Tag, term

**Answer**:
The yes (relevant) or no (not relevant) of the reader for one article that the reader saw. The answers are the taught articles.
_Avoid_: Label (for the reader's answer), feedback, rating

**Taught article**:
An article with an answer. The filter compares its similarity with the similarities of the stream.
_Avoid_: Training example, sample

**Stream**:
The articles that the filter decides on, for example the new articles of the feed since the last decision. The calibration is fitted on the similarities of the stream.
_Avoid_: Feed (for the articles to decide on), batch, corpus

**Similarity**:
The cosine of the vector of an article and the description vector.
_Avoid_: Score (for the cosine), distance

**Calibration**:
The step that makes a similarity a probability. The filter fits a binormal model on the stream and the taught similarities. When that fit cannot hold, it uses Platt's method on the taught similarities.
_Avoid_: Normalisation, scaling

**Binormal model**:
Two normal distributions of the similarities: one for the relevant articles and one for the others, with the share of relevant articles. The standard term is a score-distribution model (Manmatha et al. 2001; Arampatzis and van Hameren 2001).
_Avoid_: Mixture (alone), Gaussian

**Keyword evidence**:
The change of the probability of an article when it matches a keyword, or does not match, as naive Bayes computes it.
_Avoid_: Boost, bonus

**Probability**:
The calibrated chance, from 0 to 1, that an article is relevant to the profile.
_Avoid_: Confidence, score

**Ranking**:
The articles of the stream, the best first. The reader shows the best N of each day. The standard term is routing (TREC).
_Avoid_: Sort, feed (for the ranking), score list

**Threshold**:
The lowest probability that the filter accepts. It maximises the expected F0.5 of the stream. It is not recommended for decisions.
_Avoid_: Cut-off, limit

**Accepted article**:
An article that the threshold accepts. A reader shows the ranking, not the accepted articles.
_Avoid_: Match, hit, positive

**Calibrated filter**:
The decisions of a profile with at least one relevant answer. Its probabilities are calibrated.
_Avoid_: Classifier, model

**Keyword filter**:
The decisions of a profile with no relevant answer. It accepts the articles that match a keyword. Its probability is 1 for a match and 0 for the others, and it is not calibrated.
_Avoid_: Fallback filter
