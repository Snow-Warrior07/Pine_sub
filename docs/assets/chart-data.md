| Scenario | Final status | Iterations | Accepted | Rejected output | Provider errors | Est. cost (USD) | Rubric |
|---|---|---|---|---|---|---|---|
| 01-happy-path | DEPLOYED | 2 | 10 | 0 | 0 | 0.1861 | 98 |
| 02-architect-developer-disagreement | AWAITING_APPROVAL | 2 | 9 | 0 | 0 | 0.1776 | 98 |
| 03-tests-fail-escalation | ESCALATED | 3 | 12 | 0 | 0 | 0.2369 | - |
| 04-security-critical | AWAITING_APPROVAL | 2 | 10 | 0 | 0 | 0.1884 | 98 |
| 05-malformed-output | AWAITING_APPROVAL | 1 | 7 | 2 | 0 | 0.1529 | 100 |
| 06-provider-failover | AWAITING_APPROVAL | 1 | 7 | 0 | 3 | 0.0931 | 100 |
| 07-provider-outage-resume | AWAITING_APPROVAL | 1 | 7 | 0 | 6 | 0.1259 | 100 |
| 08-unrelated-file | AWAITING_APPROVAL | 2 | 8 | 0 | 0 | 0.1691 | 98 |
| 09-repeat-action | ESCALATED | 2 | 7 | 0 | 0 | 0.1607 | - |
| 10-disagreement-escalation | AWAITING_APPROVAL | 3 | 11 | 0 | 0 | 0.2293 | 96 |

| Agent | Calls (01) | Cost USD (01) | Input tokens (all) | Output tokens (all) |
|---|---|---|---|---|
| analyst | 1 | 0.0172 | 4,049 | 8,719 |
| architect | 1 | 0.0225 | 22,788 | 7,935 |
| qa | 3 | 0.0299 | 19,686 | 9,607 |
| developer | 2 | 0.0848 | 44,244 | 31,544 |
| security | 2 | 0.0218 | 35,919 | 543 |
| release | 1 | 0.0099 | 12,711 | 1,416 |
