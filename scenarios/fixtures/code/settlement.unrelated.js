// Daily settlement: what each merchant is owed (net of refunds). Owned by the Settlements team.
export function settlementTotals(store) {
  const totals = {};
  for (const e of store.ledger) {
    const p = store.payments.get(e.paymentId);
    if (!p) continue;
    const sign = e.type === 'CAPTURE' ? 1 : -1;
    totals[p.merchantId] = (totals[p.merchantId] ?? 0) + sign * e.amount;
  }
  return totals;
}
