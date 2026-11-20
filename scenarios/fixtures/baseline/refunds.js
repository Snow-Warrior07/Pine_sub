import { assertAmount } from './money.js';
import { recordEntry } from './ledger.js';
import { log } from './logger.js';
import { PaymentStatus } from './payments.js';

export function createRefundService(store) {
  const seen = new Map();

  function refund({ paymentId, amount, idempotencyKey }) {
    if (!idempotencyKey) throw new Error('idempotencyKey is required');
    const key = `${paymentId}:${idempotencyKey}`;
    if (seen.has(key)) return seen.get(key);
    assertAmount(amount);
    const p = store.payments.get(paymentId);
    if (!p) throw new Error(`Payment ${paymentId} not found`);
    if (p.status !== PaymentStatus.CAPTURED && p.status !== PaymentStatus.PARTIALLY_REFUNDED) {
      throw new Error(`Cannot refund payment in status ${p.status}`);
    }
    if (p.refundedAmount + amount > p.amount) throw new RangeError('Refund exceeds captured amount');
    const r = { id: `rf_${store.refunds.size + 1}`, paymentId, amount, idempotencyKey, status: 'SUCCEEDED' };
    store.refunds.set(r.id, r);
    seen.set(key, r);
    p.refundedAmount += amount;
    p.status = p.refundedAmount === p.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
    recordEntry(store, { type: 'REFUND', paymentId, amount, reference: r.id });
    log('refund.created', { refundId: r.id, paymentId, amount });
    return r;
  }

  return { refund, listRefunds: (id) => [...store.refunds.values()].filter((r) => r.paymentId === id) };
}
