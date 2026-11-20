# Review summary: REQ-101: partial refunds (4 files)

| Field | Value |
|---|---|
| Run | `demo-08-unrelated-file` (scenario `08-unrelated-file`) |
| Status | **AWAITING_APPROVAL**: All gates passed. Merge and deployment need human approval. |
| Branch | `agent/demo-08-unrelated-file` (main untouched until approval) |
| Iterations | 2 |
| Model calls | 8 (0 failed or rejected) |
| Tokens | 11,969 in / 6,063 out |
| Estimated cost | $0.1691 (simulated: mock provider priced as Claude) |
| Rubric score | 98/100 |

## Summary

Adds partial refunds with cumulative-amount guard and idempotency keys. Converged in 2 iteration(s).

## Test evidence

- 15/15 tests passed (regression, developer unit and QA acceptance suites)
- Line coverage 93.36% (threshold 80%)
- Static security scan: 0 finding(s); lint: 0 issue(s)

## Known risks

- Idempotency index is in memory; it must move to the database before multi-instance deployment.
- Concurrent refunds on the same payment are not serialised (single-threaded sample service).

## Rollback plan

Revert the merge commit; no schema or ledger entry-type changes were made, so no data migration is needed.

## Acceptance criteria

| ID | Given | When | Then | Verified |
|---|---|---|---|---|
| AC-1 | a CAPTURED payment of INR 100.00 | the merchant refunds INR 30.00 | the refund succeeds, refundedAmount is 3000 paise and the status is PARTIALLY_REFUNDED | yes |
| AC-2 | a payment with INR 60.00 of 100.00 already refunded | the merchant requests a further INR 50.00 refund | the request is rejected and refundedAmount stays 6000 paise | yes |
| AC-3 | a partially refunded payment | the remaining balance is refunded | the status becomes REFUNDED | yes |
| AC-4 | a refund request with idempotency key K | the same request with key K is retried | the original refund is returned and no second refund or ledger entry is created | yes |
| AC-5 | a payment that is not captured, or an amount that is zero or not whole paise | a refund is requested | the request is rejected | yes |
| AC-6 | any successful refund | it is processed | a REFUND ledger entry with the refunded amount exists and no log line contains the card number | yes |

## Open questions for the approver

- Should partial refunds be limited by the 180-day refund window in config/gateway.config.json? Assumed out of scope for this change.

## Assumptions made by the agents

- Amounts are integer paise, as in the existing service.
- Idempotency keys are unique per payment, not globally.
- Existing full-refund behaviour (refundPayment) must keep working.

## Design decisions

- **ADR-1**: Partial refunds live in a new module, src/refunds.js. _Keeps payments.js small and isolates the new behaviour for review and rollback._
- **ADR-2**: Use the existing REFUND ledger entry type for partial refunds. _Ledger entry types are agreed with Finance; settlement already nets REFUND entries correctly._
- **ADR-3**: Idempotency keys are scoped per payment and stored in memory for now. _Matches the in-memory store; flagged as a known risk for multi-instance deployment._

## Iteration history

| # | Gate | Tests | Coverage | SAST | Feedback |
|---|---|---|---|---|---|
| 1 | blocked_by_policy | - | - | - | src/settlement.js is not in the architect's allowed_files; unrelated file changes are blocked<br>Only change: src/refunds.js, src/payments.js, test/refunds.test.js |
| 2 | pass | 15/15 | 93.36% | 0 | - |

## Rubric

| Criterion | Points | Detail |
|---|---|---|
| Acceptance criteria verified by passing tests | 30/30 | 6/6 (AC-1, AC-2, AC-3, AC-4, AC-5, AC-6) |
| Full test suite green | 20/20 | 15/15 passed |
| No critical/high security findings | 15/15 | 0 blocking, 0 total |
| Stayed within the design scope | 10/10 | 3 file(s), all allowed |
| Coverage >= 80% | 10/10 | 93.36% |
| Change size vs human baseline | 10/10 | 110 vs 85 lines (1.29x) |
| Iterations to converge | 3/5 | 2 of 3 |

## Approve or reject

```bash
npm run approve -- demo-08-unrelated-file --by "<your name>" --note "<why>"
```

```bash
npm run reject -- demo-08-unrelated-file --by "<your name>" --note "<why>"
```
