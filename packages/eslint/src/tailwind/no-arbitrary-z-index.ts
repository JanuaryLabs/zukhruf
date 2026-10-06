import { classNameCheck } from './class-name-check.ts';

export default classNameCheck({
  description:
    'Disallow arbitrary z-[N] classes; stacking order comes from the theme tokens',
  pattern: 'z-\\[',
  message:
    'Use the z-index theme tokens instead of an arbitrary z-[N]. Add a new value to the @theme block when the scale lacks one.',
});
