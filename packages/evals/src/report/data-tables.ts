import type { Ends, Mark, Tone } from '../index.ts';
import type { Numbers } from './part.ts';

// The icon and the word of each mark of a value pair, so that a mark never
// reads by colour alone.
export const marks: Readonly<
  Record<Mark, { readonly icon: string; readonly label: string }>
> = {
  agree: { icon: '✓', label: 'agrees' },
  near: { icon: '≈', label: 'near' },
  disagree: { icon: '✗', label: 'disagrees' },
  'only-expected': { icon: '−', label: 'only expected' },
  'only-actual': { icon: '+', label: 'only actual' },
};

// The icon of a tone beside its colour; a neutral value has none.
export const tones: Readonly<Record<Tone, string>> = {
  good: '✓',
  bad: '✗',
  neutral: '',
};

// A number that a value does not have shows as a dash (mteb's `known`).
export const fixed = (value: number) =>
  Number.isNaN(value) ? '—' : value.toFixed(3);

// The resamples that an interval comes from, when some had no value (#6267),
// such as " from 1271 of 2000 resamples"; an interval of all of them, or no
// interval, adds nothing.
export const kept = (
  interval:
    { readonly resamples: number; readonly nResamples: number } | undefined,
) =>
  interval === undefined || interval.resamples === interval.nResamples
    ? ''
    : ` from ${interval.resamples} of ${interval.nResamples} resamples`;

// A value with its interval, such as 0.868 [0.800, 0.930]. An interval with
// no known end, as a missing value has, is left out.
export const withEnds = (value: number, ends: Ends | undefined) =>
  ends === undefined || (Number.isNaN(ends.low) && Number.isNaN(ends.high))
    ? fixed(value)
    : `${fixed(value)} [${fixed(ends.low)}, ${fixed(ends.high)}]`;

// A value with its interval and the resamples the interval keeps (#6267).
export const withKept = ({ value, ends, interval }: Numbers) =>
  `${withEnds(value, ends)}${kept(interval)}`;
