# payments-service (sample target repository)

A deliberately small merchant-payments service. It is the **target repository** that the
agent workflow modifies. Amounts are integers in paise (1 INR = 100 paise).

| Module | Responsibility | Owner |
|---|---|---|
| `src/payments.js` | Create, capture, fetch and fully refund payments | Payments team |
| `src/ledger.js` | Append-only accounting ledger (fixed entry types) | Finance platform team |
| `src/settlement.js` | Daily merchant settlement totals | Settlements team |
| `src/logger.js` | Structured logging with PAN redaction | Platform team |
| `src/money.js` | Amount validation helpers | Payments team |
| `src/store.js` | In-memory store (stands in for a database) | Payments team |
| `config/` | Gateway configuration (protected) | SRE |

Run the tests with `npm test` (Node 22+, no dependencies).
