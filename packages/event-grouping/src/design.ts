// One term of the pair score. It standardizes one feature with the mean and
// the standard deviation of the training pairs, and weights it.
export type Term = {
  readonly weight: number;
  readonly mean: number;
  readonly sd: number;
};

// The whole recipe of a research round: the model that makes the vectors,
// how a report becomes a vector text, the shortlist, the window, the pair
// score and the threshold. The weights and the threshold belong to one
// embedding model (docs/adr/0004), so the design names it.
export type Design = {
  // The name of the design, for example the research round that froze it.
  readonly name: string;
  // The sha256 of the plan.json of the research round.
  readonly planSha256: string;
  // The name of the embedding model that the round fitted the design for.
  readonly embeddingModel: string;
  // Which segments of the body are real sentences, and how many of them
  // make the lead (src/lead.ts).
  readonly lead: {
    readonly sentences: number;
    readonly minWords: number;
    readonly minLetterRatio: number;
    readonly maxUrlShare: number;
    // A regular expression source. It matches one URL.
    readonly urlPattern: string;
    // Without clean, the URLs go away inside each sentence, and the numbers
    // come from the title and the whole body. With clean, the URLs go away
    // from the body before the sentence split, and the numbers come from the
    // title and the body without its URLs and its template segments.
    readonly clean?: {
      // A segment is a template of its publisher when at least this many
      // reports of the publisher hold it (src/templates.ts). A template
      // segment is in no lead and gives no number. Null: no segment is a
      // template.
      readonly templateReports: number | null;
    };
  };
  // The text that the model embeds. {title} is the title of the lead, and
  // {lead} is its sentences, with a space between them.
  readonly vectorText: string;
  // The number of nearest reports that a report is compared with.
  readonly shortlistSize: number;
  // The number of publish days before and after a report that its shortlist
  // and the clustering of a new day look at.
  readonly windowDays: number;
  // Two reports report one event when their pair score is at least this
  // value.
  readonly threshold: number;
  // The logistic regression of the pair score (src/pair-score.ts).
  readonly pairScore: {
    readonly intercept: number;
    readonly similarity: Term;
    readonly agreeingNumbers: Term;
    readonly disagreeingNumbers: Term;
    readonly samePublisher: Term;
    // The similarity of two reports of one publisher, and 0 for other pairs.
    // With it, the pair score of two reports of one publisher has its own
    // slope on the similarity. Without it, the term is not in the score.
    readonly samePublisherSimilarity?: Term;
  };
};
