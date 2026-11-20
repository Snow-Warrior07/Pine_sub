// Append-only accounting ledger. Owned by the Finance platform team.
// Entry types are a closed set agreed with Finance; adding one needs their sign-off.
export const ENTRY_TYPES = Object.freeze(['CAPTURE', 'REFUND']);

export function recordEntry(store, { type, paymentId, amount, reference = null }) {
  if (!ENTRY_TYPES.includes(type)) {
    throw new Error(`Unknown ledger entry type: ${type}`);
  }
  const entry = { seq: store.ledger.length + 1, type, paymentId, amount, reference };
  store.ledger.push(entry);
  return entry;
}

export function entriesFor(store, paymentId) {
  return store.ledger.filter((e) => e.paymentId === paymentId);
}
