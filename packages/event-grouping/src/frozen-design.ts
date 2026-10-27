// The parameters of design 3152b. Round #3152 chose the pair score, and its
// second selection (3152b) chose the threshold with the CoNLL F0.5 objective.
// 3152b froze them in its plan.json before it scored its exam set. The lead
// rule, the shortlist and the window are those of round #3130
// (docs/adr/0001). Change a parameter only with a new research round
// (docs/adr/0005).

// The sha256 of that plan.json (eval/scoreboard.json pins the design to it).
export const PLAN_SHA256 =
  'dc26dbd8c26341ca4245552d017161307f30b79aef4bc5ba3a171a72a534c479';

// The lead rule (plan.json design.leadRule, scripts/lead.ts of round #3130).
export const LEAD_SENTENCES = 2;
export const MIN_WORDS = 5;
export const MIN_LETTER_RATIO = 0.6;
export const MAX_URL_SHARE = 0.5;
export const URL_PATTERN = String.raw`(?:https?://|www\.)\S*`;

// The shortlist and the window (plan.json design.shortlistSize and
// design.windowDays).
export const SHORTLIST_SIZE = 80;
export const WINDOW_DAYS = 7;

// Two reports report one event when their pair score is at least this value
// (plan.json design.threshold).
export const THRESHOLD = 0.45;

// The logistic regression of the pair score (plan.json design.model). Each
// term standardizes one feature with the mean and the standard deviation of
// the training pairs.
export const INTERCEPT = -5.577353541021158;
export const SIMILARITY_TERM = {
  weight: 2.463189037261233,
  mean: 0.6697853674594684,
  sd: 0.0768108602613357,
};
export const AGREEING_NUMBERS_TERM = {
  weight: 1.2184550356722605,
  mean: 0.7080452669318389,
  sd: 0.7146516956780061,
};
export const DISAGREEING_NUMBERS_TERM = {
  weight: -0.8987930339729852,
  mean: 1.6871729914951807,
  sd: 0.8093686065424462,
};
// The feature is 1 when the two reports have the same publisher, and 0 when
// they have different publishers or one of them has no publisher.
export const SAME_PUBLISHER_TERM = {
  weight: -0.6864362601504641,
  mean: 0.12460342227076507,
  sd: 0.3302686927775403,
};
