# REQ-101: Partial refunds for captured payments

**Requested by:** Merchant Experience PM
**Priority:** P1 (top merchant ask this quarter)

Merchants today can only refund the full amount of a payment. They need to refund part
of a captured payment, for example when one item of a multi-item order is returned.

- A captured payment can be refunded in one or more parts.
- The total refunded must never exceed the captured amount.
- Merchants' systems retry on network failures, so a retried refund request must not
  refund twice.
- Finance needs every refund to appear in the ledger.
- Card numbers must never appear in logs (PCI DSS).
