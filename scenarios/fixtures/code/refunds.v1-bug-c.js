import { assertAmount } from './money.js';
import { recordEntry } from './ledger.js';
import { log } from './logger.js';
import { PaymentStatus } from './payments.js';

const REFUNDABLE = new Set([PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED]);

export function createRefundService(store) {
  // Idempotency index: key -> refund. Scoped per payment so keys cannot collide across payments.
  const byKey = new Map();

  function refund({ paymentId, amount, idempotencyKey }) {
    if (!idempotencyKey) throw new Error('idempotencyKey is required');
    const scopedKey = `${paymentId}:${idempotencyKey}`;
    if (byKey.has(scopedKey)) return byKey.get(scopedKey);

    assertAmount(amount);
    const payment = store.payments.get(paymentId);
    if (!payment) throw new Error(`Payment ${paymentId} not found`);
    if (!REFUNDABLE.has(payment.status)) {
      throw new Error(`Cannot refund payment in status ${payment.status}`);
    }

    const alreadyRefunded = payment.refundedAmount ?? 0;
    const remaining = payment.amount;
    if (amount > remaining || amount > payment.amount) {
      throw new RangeError(`Refund of ${amount} exceeds refundable balance of ${remaining}`);
    }

    const record = {
      id: `rf_${store.refunds.size + 1}`,
      paymentId,
      amount,
      idempotencyKey,
      status: 'SUCCEEDED',
    };
    store.refunds.set(record.id, record);
    byKey.set(scopedKey, record);

    payment.refundedAmount = alreadyRefunded + amount;
    payment.status =
      payment.refundedAmount === payment.amount
        ? PaymentStatus.REFUNDED
        : PaymentStatus.PARTIALLY_REFUNDED;

    recordEntry(store, { type: 'REFUND', paymentId, amount, reference: record.id });
    log('refund.created', { refundId: record.id, paymentId, amount });
    return record;
  }

  function listRefunds(paymentId) {
    return [...store.refunds.values()].filter((r) => r.paymentId === paymentId);
  }

  return { refund, listRefunds };
}
