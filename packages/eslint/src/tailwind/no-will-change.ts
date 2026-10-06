import { classNameCheck } from './class-name-check.ts';

export default classNameCheck({
  description: 'Disallow will-change classes',
  pattern: 'will-change',
  message:
    'Avoid will-change in Tailwind classes. Only use within active CSS animations if absolutely necessary.',
});
