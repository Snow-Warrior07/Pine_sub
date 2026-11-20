import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createPaymentService, PaymentStatus } from '../src/payments.js';
import { createRefundService } from '../src/refunds.js';
import { setLogSink } from '../src/logger.js';

setLogSink(() => {});

function captured(amount = 10000) {
  const store = createStore();
  const payments = createPaymentService(store);
  payments.createPayment({ id: 'pay_1', merchantId: 'm_1', amount, cardNumber: '4111111111111111' });
  payments.capturePayment('pay_1');
  return { store, payments, refunds: createRefundService(store) };
}

test('partially refunds a captured payment', () => {
  const { payments, refunds } = captured();
  const r = refunds.refund({ paymentId: 'pay_1', amount: 2500, idempotencyKey: 'k1' });
  assert.equal(r.status, 'SUCCEEDED');
  assert.equal(payments.getPayment('pay_1').status, PaymentStatus.PARTIALLY_REFUNDED);
});

test('returns the same refund for a repeated idempotency key', () => {
  const { refunds } = captured();
  const a = refunds.refund({ paymentId: 'pay_1', amount: 1000, idempotencyKey: 'k1' });
  const b = refunds.refund({ paymentId: 'pay_1', amount: 1000, idempotencyKey: 'k1' });
  assert.equal(a.id, b.id);
  assert.equal(refunds.listRefunds('pay_1').length, 1);
});

test('requires an idempotency key', () => {
  const { refunds } = captured();
  assert.throws(() => refunds.refund({ paymentId: 'pay_1', amount: 100 }), /idempotencyKey/);
});

test('rejects a single refund larger than the payment', () => {
  const { refunds } = captured();
  assert.throws(() => refunds.refund({ paymentId: 'pay_1', amount: 20000, idempotencyKey: 'k1' }), RangeError);
});
