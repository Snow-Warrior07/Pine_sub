// Amounts are integer paise. Floats are rejected to avoid rounding errors.
export function assertAmount(amount, field = 'amount') {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError(`${field} must be a positive integer number of paise`);
  }
  return amount;
}

export function formatINR(paise) {
  return `INR ${(paise / 100).toFixed(2)}`;
}
