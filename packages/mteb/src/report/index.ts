// @zukhruf/mteb/report: a report of the results of a retrieval task, from
// the result cache and the predictions that evaluate wrote. Not from MTEB.
export {
  type ModelScores,
  Report,
  type ReportData,
  type ReportOptions,
  type SplitReport,
} from './report.ts';
export {
  type Comparison,
  type PrimaryComparison,
  type Verdict,
  decide,
  verdicts,
} from './verdicts.ts';
