// repr() of a float in CPython: the shortest digits that read back as the
// same float, in fixed notation when the exponent is from -4 to 15, and
// always with a fraction (Python/pystrtod.c, format_float_short, mode 'r').
export function floatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const [mantissa = '', exponentText = '0'] = value.toExponential().split('e');
  const sign = mantissa.startsWith('-') || Object.is(value, -0) ? '-' : '';
  const digits = mantissa.replace('-', '').replace('.', '');
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.slice(1);
    const magnitude = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits[0]}${fraction ? `.${fraction}` : ''}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction || '0'}`;
}
