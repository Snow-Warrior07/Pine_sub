// Acceptance tests written by the QA agent from the acceptance criteria, BEFORE the
// developer agent writes any code. The developer agent is not allowed to edit this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.js';
import { createPaymentService, PaymentStatus } from '../../src/payments.js';
import { createRefundService } from '../../src/refunds.js';
import { setLogSink } from '../../src/logger.js';

const logLines = [];
setLogSink((line) => logLines.push(line));

function captured(amount = 10000) {
  const store = createStore();
  const payments = createPaymentService(store);
  payments.createPayment({ id: 'pay_1', merchantId: 'm_1', amount, cardNumber: '4111111111111111' });
  payments.capturePayment('pay_1');
  return { store, payments, refunds: createRefundService(store) };
}

test('AC-1 partial refund on a captured payment marks it PARTIALLY_REFUNDED', () => {
  const { payments, refunds } = captured();
  refunds.refund({ paymentId: 'pay_1', amount: 3000, idempotencyKey: 'a' });
  const p = payments.getPayment('pay_1');
  assert.equal(p.status, PaymentStatus.PARTIALLY_REFUNDED);
  assert.equal(p.refundedAmount, 3000);
});

test('AC-2 cumulative refunds can never exceed the captured amount', () => {
  const { payments, refunds } = captured();
  refunds.refund({ paymentId: 'pay_1', amount: 6000, idempotencyKey: 'a' });
  assert.throws(() => refunds.refund({ paymentId: 'pay_1', amount: 5000, idempotencyKey: 'b' }));
  assert.equal(payments.getPayment('pay_1').refundedAmount, 6000);
});

test('AC-3 refunding the remaining balance marks the payment REFUNDED', () => {
  const { payments, refunds } = captured();
  refunds.refund({ paymentId: 'pay_1', amount: 4000, idempotencyKey: 'a' });
  refunds.refund({ paymentId: 'pay_1', amount: 6000, idempotencyKey: 'b' });
  assert.equal(payments.getPayment('pay_1').status, PaymentStatus.REFUNDED);
});

test('AC-4 a retried request with the same idempotency key refunds only once', () => {
  const { store, refunds } = captured();
  refunds.refund({ paymentId: 'pay_1', amount: 2000, idempotencyKey: 'retry-me' });
  refunds.refund({ paymentId: 'pay_1', amount: 2000, idempotencyKey: 'retry-me' });
  assert.equal(store.ledger.filter((e) => e.type === 'REFUND').length, 1);
});

test('AC-5 refunds are rejected for uncaptured payments and invalid amounts', () => {
  const store = createStore();
  const payments = createPaymentService(store);
  const refunds = createRefundService(store);
  payments.createPayment({ id: 'pay_2', merchantId: 'm_1', amount: 5000, cardNumber: '4111111111111111' });
  assert.throws(() => refunds.refund({ paymentId: 'pay_2', amount: 100, idempotencyKey: 'a' }));
  payments.capturePayment('pay_2');
  assert.throws(() => refunds.refund({ paymentId: 'pay_2', amount: 10.5, idempotencyKey: 'b' }));
  assert.throws(() => refunds.refund({ paymentId: 'pay_2', amount: 0, idempotencyKey: 'c' }));
});

test('AC-6 every refund is in the ledger and card numbers never reach the logs', () => {
  const { store, refunds } = captured();
  logLines.length = 0;
  refunds.refund({ paymentId: 'pay_1', amount: 1500, idempotencyKey: 'a' });
  const entry = store.ledger.find((e) => e.type === 'REFUND');
  assert.equal(entry.amount, 1500);
  assert.ok(logLines.every((l) => !l.includes('4111111111111111')));
});
