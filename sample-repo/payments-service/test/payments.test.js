import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createPaymentService, PaymentStatus } from '../src/payments.js';
import { setLogSink } from '../src/logger.js';
import { settlementTotals } from '../src/settlement.js';

setLogSink(() => {});

function setup() {
  const store = createStore();
  const svc = createPaymentService(store);
  svc.createPayment({ id: 'pay_1', merchantId: 'm_1', amount: 10000, cardNumber: '4111111111111111' });
  return { store, svc };
}

test('captures a created payment and writes a ledger entry', () => {
  const { store, svc } = setup();
  svc.capturePayment('pay_1');
  assert.equal(svc.getPayment('pay_1').status, PaymentStatus.CAPTURED);
  assert.equal(store.ledger.length, 1);
});

test('rejects non-integer amounts', () => {
  const svc = createPaymentService(createStore());
  assert.throws(() => svc.createPayment({ id: 'x', merchantId: 'm', amount: 10.5, cardNumber: '4111' }), RangeError);
});

test('fully refunds a captured payment', () => {
  const { svc } = setup();
  svc.capturePayment('pay_1');
  svc.refundPayment('pay_1');
  assert.equal(svc.getPayment('pay_1').status, PaymentStatus.REFUNDED);
});

test('cannot refund an uncaptured payment', () => {
  const { svc } = setup();
  assert.throws(() => svc.refundPayment('pay_1'), /Cannot refund/);
});

test('settlement nets captures and refunds per merchant', () => {
  const { store, svc } = setup();
  svc.capturePayment('pay_1');
  svc.refundPayment('pay_1');
  assert.deepEqual(settlementTotals(store), { m_1: 0 });
});
