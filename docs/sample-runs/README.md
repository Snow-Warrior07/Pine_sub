# Sample runs

Outputs from `npm run demo:all -- --publish`, one folder per scenario. All model responses come from the
scripted mock provider; tests, coverage, lint, security scan, git and the policy checks ran for real.

| Scenario | Shows | Final state | Open |
|---|---|---|---|
| 01-happy-path | Minimum demo: one failed check (AC-2), fixed, then human approval (approved twice; merged once) | DEPLOYED (simulated) | [evidence](01-happy-path/evidence.md) |
| 02-architect-developer-disagreement | Architect rejects the developer's ledger change; developer complies | AWAITING_APPROVAL | [evidence](02-architect-developer-disagreement/evidence.md) |
| 03-tests-fail-escalation | Three failing attempts, then escalation instead of looping | ESCALATED | [evidence](03-tests-fail-escalation/evidence.md) |
| 04-security-critical | Card number logged: critical finding blocks the release path | AWAITING_APPROVAL | [evidence](04-security-critical/evidence.md) |
| 05-malformed-output | Truncated JSON and an unsupported value, both repaired | AWAITING_APPROVAL | [evidence](05-malformed-output/evidence.md) |
| 06-provider-failover | Primary provider down mid-run: retry, circuit breaker, failover | AWAITING_APPROVAL | [evidence](06-provider-failover/evidence.md) |
| 07-provider-outage-resume | All providers down: pause, then resume from the checkpoint | AWAITING_APPROVAL | [evidence](07-provider-outage-resume/evidence.md) |
| 08-unrelated-file | Edit to another team's module blocked by the scope policy | AWAITING_APPROVAL | [evidence](08-unrelated-file/evidence.md) |
| 09-repeat-action | Identical change set resubmitted: detected, not re-applied, escalated | ESCALATED | [evidence](09-repeat-action/evidence.md) |
| 10-disagreement-escalation | Persistent disagreement escalated; a human rules; run continues | AWAITING_APPROVAL | [evidence](10-disagreement-escalation/evidence.md) |

Each folder contains:

- `evidence.md`: review summary for the approver (criteria, test evidence, risks, rollback, iteration history, rubric)
- `report.html`: visual run report (download and open in a browser)
- `events.jsonl`: append-only audit trail
- `metrics.json`: tokens, latency, cost per agent and provider
- `state.json`: the persisted checkpoint
