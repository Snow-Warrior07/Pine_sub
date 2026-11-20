import { assertAmount } from './money.js';
import { recordEntry } from './ledger.js';
import { log, redact } from './logger.js';

export const PaymentStatus = Object.freeze({
  CREATED: 'CREATED',
  CAPTURED: 'CAPTURED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
});

export function createPaymentService(store) {
  function createPayment({ id, merchantId, amount, cardNumber }) {
    if (store.payments.has(id)) throw new Error(`Payment ${id} already exists`);
    assertAmount(amount);
    const payment = {
      id,
      merchantId,
      amount,
      cardNumber,
      refundedAmount: 0,
      status: PaymentStatus.CREATED,
    };
    store.payments.set(id, payment);
    log('payment.created', { payment: redact(payment) });
    return payment;
  }

  function getPayment(id) {
    const payment = store.payments.get(id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    return payment;
  }

  function capturePayment(id) {
    const payment = getPayment(id);
    if (payment.status !== PaymentStatus.CREATED) {
      throw new Error(`Cannot capture payment in status ${payment.status}`);
    }
    payment.status = PaymentStatus.CAPTURED;
    recordEntry(store, { type: 'CAPTURE', paymentId: id, amount: payment.amount });
    log('payment.captured', { paymentId: id });
    return payment;
  }

  // Full refund of a captured payment. Partial refunds live in refunds.js.
  function refundPayment(id) {
    const payment = getPayment(id);
    if (payment.status !== PaymentStatus.CAPTURED) {
      throw new Error(`Cannot refund payment in status ${payment.status}`);
    }
    payment.status = PaymentStatus.REFUNDED;
    payment.refundedAmount = payment.amount;
    recordEntry(store, { type: 'REFUND', paymentId: id, amount: payment.amount });
    log('payment.refunded', { paymentId: id });
    return payment;
  }

  return { createPayment, getPayment, capturePayment, refundPayment };
}
