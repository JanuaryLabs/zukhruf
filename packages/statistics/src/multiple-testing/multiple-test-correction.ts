// A rule that adjusts the p-values of several tests of one family, so that a
// test that reads its adjusted p-value against a level keeps the error of the
// whole family at that level: the method of R's p.adjust and of statsmodels'
// multipletests, such as 'holm' (Strategy). The adjusted p-values are in the
// order of the p-values.
export interface MultipleTestCorrection {
  adjust(pValues: readonly number[]): number[];
}
