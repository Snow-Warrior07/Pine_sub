# Review summary: demo-09-repeat-action

| Field | Value |
|---|---|
| Run | `demo-09-repeat-action` (scenario `09-repeat-action`) |
| Status | **ESCALATED**: No progress: developer repeated the change set from iteration 1 |
| Branch | `agent/demo-09-repeat-action` (main untouched until approval) |
| Iterations | 2 |
| Model calls | 7 (0 failed or rejected) |
| Tokens | 11,399 in / 5,753 out |
| Estimated cost | $0.1607 (simulated: mock provider priced as Claude) |

## Acceptance criteria

| ID | Given | When | Then | Verified |
|---|---|---|---|---|
| AC-1 | a CAPTURED payment of INR 100.00 | the merchant refunds INR 30.00 | the refund succeeds, refundedAmount is 3000 paise and the status is PARTIALLY_REFUNDED | no |
| AC-2 | a payment with INR 60.00 of 100.00 already refunded | the merchant requests a further INR 50.00 refund | the request is rejected and refundedAmount stays 6000 paise | no |
| AC-3 | a partially refunded payment | the remaining balance is refunded | the status becomes REFUNDED | no |
| AC-4 | a refund request with idempotency key K | the same request with key K is retried | the original refund is returned and no second refund or ledger entry is created | no |
| AC-5 | a payment that is not captured, or an amount that is zero or not whole paise | a refund is requested | the request is rejected | no |
| AC-6 | any successful refund | it is processed | a REFUND ledger entry with the refunded amount exists and no log line contains the card number | no |

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
| 1 | fail | 14/15 | 93.36% | 0 | QA: Test "AC-2 cumulative refunds can never exceed the captured amount" failed: Missing expected exception. |
| 2 | no_progress | - | - | - | Change set identical to iteration 1 |

## Escalation: a human decision is needed

No progress: developer repeated the change set from iteration 1

- [ ] Give the developer agent new guidance and resume
- [ ] Take over the branch manually
- [ ] Reject the run
