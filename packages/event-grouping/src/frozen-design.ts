// The parameters of the design that passed research round #3130. Round #3130
// froze them in its plan.json (sha256 5ad0b727f8ae67a1f25bd25719e550952ab1449e3dce1fad551714f63a3ade4f)
// before it scored its test set. Change a parameter only with a new research
// round (docs/adr/0001).

// The lead rule (plan.json leadRule, scripts/lead.ts of the round).
export const LEAD_SENTENCES = 2;
export const MIN_WORDS = 5;
export const MIN_LETTER_RATIO = 0.6;
export const MAX_URL_SHARE = 0.5;
export const URL_PATTERN = String.raw`(?:https?://|www\.)\S*`;

// The shortlist and the window (plan.json design.k and design.windowDays).
export const SHORTLIST_SIZE = 80;
export const WINDOW_DAYS = 7;

// Two reports report one event when their pair score is at least this value
// (plan.json design.threshold).
export const THRESHOLD = 0.5;

// The logistic regression of the pair score (plan.json design.model). Each
// term standardizes one feature with the mean and the standard deviation of
// the training pairs.
export const INTERCEPT = -5.45562362357198;
export const SIMILARITY_TERM = {
  weight: 2.554141188012624,
  mean: 0.6578909320141326,
  sd: 0.08434943813934904,
};
export const AGREEING_NUMBERS_TERM = {
  weight: 1.1986310686642012,
  mean: 0.49545111323470553,
  sd: 0.6286163041119666,
};
export const DISAGREEING_NUMBERS_TERM = {
  weight: -1.140358901882716,
  mean: 1.439193455150203,
  sd: 0.8065878434833612,
};
