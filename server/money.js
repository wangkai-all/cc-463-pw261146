/**
 * All monetary values are integer cents inside the system. Raw source payloads
 * may carry strings such as "1280.00"; they are parsed exactly once at
 * normalisation time and never converted back to floats for arithmetic.
 */
export function parseCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid money value: ${value}`);
    return Math.round(value * 100);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '');
    if (!/^-?\d+(\.\d{1,4})?$/.test(trimmed)) {
      throw new Error(`Invalid money value: ${value}`);
    }
    const negative = trimmed.startsWith('-');
    const [whole, fraction = ''] = trimmed.replace('-', '').split('.');
    if (fraction.length > 2) {
      // Sub-cent precision would be silently lost; refuse it at ingest instead.
      if (!/^[0]*$/.test(fraction.slice(2))) throw new Error(`Invalid money value: ${value}`);
    }
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
    return negative ? -cents : cents;
  }
  throw new Error(`Invalid money value: ${value}`);
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

export function addCents(...values) {
  return values.reduce((sum, value) => sum + (value || 0), 0);
}
