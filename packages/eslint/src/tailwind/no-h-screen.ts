import { classNameCheck } from './class-name-check.ts';

export default classNameCheck({
  description:
    'Disallow h-screen classes, which miss the mobile browser chrome; use the dvh units',
  pattern: 'h-screen',
  message:
    'Use h-dvh/min-h-dvh/max-h-dvh instead of h-screen variants for correct mobile viewport behavior.',
});
