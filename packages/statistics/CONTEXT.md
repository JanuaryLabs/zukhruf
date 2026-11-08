# Statistics

An eval gives a number for a dataset, such as a mean score. This context says how sure that number is: it draws the dataset again many times and reads the spread of the numbers it gets.

## Language

**Pairwise sum**:
The order in which `numpy.sum` adds float64 values: blocks of up to 128 values in 8 accumulators, and two halves for more values. Another order can give other last bits.
_Avoid_: sum (without the order), Kahan sum (another algorithm)

**NaN mean**:
The mean that `numpy.nanmean` gives: each NaN becomes 0, the pairwise sum adds all the values, and the sum is divided by the number of values that are not NaN. A mean of only the values that are not NaN adds in other blocks, so it can give other last bits.
_Avoid_: mean of the values that are not NaN (another order)

**Resample**:
A sample of the data with as many items as the data, drawn with replacement. An item can come twice, and another item can be absent.

**Statistic**:
The number that a caller computes from the items of one resample, such as their mean.

**Bootstrap distribution**:
The statistic of each resample.

**Random index**:
An index from 0 to n − 1 that the caller's random generator gives. One random index picks one item of a resample.

**Quantile method**:
The rule that gives the value at a quantile `q` of sorted values when `(n − 1)q` is not a whole number. NumPy names these rules, such as `linear` and `inverted_cdf`.
_Avoid_: percentile function (a percentile is a quantile times 100)

**Confidence interval**:
A low and a high value, such as the 2.5% and the 97.5% quantile of a bootstrap distribution.
_Avoid_: CI

**Confidence interval method**:
The rule that gives a confidence interval from a bootstrap distribution, such as the percentile interval. SciPy calls it the `method` of `scipy.stats.bootstrap`.

**Percentile interval**:
The confidence interval that two quantiles of the bootstrap distribution give, both read with one quantile method.

**Difference interval**:
The confidence interval of (change − baseline). It lies above 0 when the change is better on every likely resample, and below 0 when it is worse. `DifferenceInterval` also holds the observed difference: the difference that the data gives. The verdict that a caller reads from it stays with the caller.
