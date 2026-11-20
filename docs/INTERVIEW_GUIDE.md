# Interview guide

Notes for presenting and defending this project.

## The 30-second pitch

> "I built a small engineering organisation of six AI agents (analyst, architect, developer, QA, security and release) that takes a product requirement for a payments service through to a merge-ready change. The key design choice is that **models propose and code decides**. A deterministic orchestrator validates every agent output, enforces file scope, runs real tests and security checks, bounds every loop, and stops at a human approval gate before anything is merged or deployed. All six failure cases in the brief are reproducible on demand and covered by automated tests."

## The 5-minute walkthrough

| Minute | Show | Say |
|---|---|---|
| 0:00 | README architecture diagram | Six agents, one orchestrator, one gateway. Agents only return JSON. Tools and humans make the decisions that matter |
| 1:00 | `npm run demo` | Watch REQ-101: 6 acceptance criteria → design with a file scope → QA writes tests first → developer's first attempt fails AC-2 → feedback → passes → stops for approval |
| 2:30 | `runs/<id>/evidence.md` | This is what the approver reads: verified criteria, test evidence, risks, rollback plan, open question flagged by the analyst |
| 3:00 | `npm run approve -- <id> --by "Me"` then run it again | Merge happens once; second approval is logged and ignored. Agents cannot approve |
| 3:30 | `npm run demo -- 04-security-critical` | Card number in logs → scanner + security agent block the release path → fixed in iteration 2 |
| 4:15 | `npm run demo -- 07-provider-outage-resume`, then `resume` | Both providers down → paused with checkpoint → resume continues without redoing analysis or design |
| 4:45 | README §7 charts | Cost per agent and per scenario; developer is the cost centre; escalation caps cost |

Backup demos: `02` (disagreement), `05` (malformed output), `08` (unrelated file), `10` (persistent disagreement → human ruling).

## What each part of the challenge was testing, and my answer

| Brief says it evaluates | Where to point |
|---|---|
| **Orchestration design** | State machine with checkpoints (`src/orchestrator.ts`), README §4; ARCHITECTURE §2 shows the iteration flow and why checks are ordered that way |
| **Coding-agent safety** | Policy guard, protected paths, path-escape checks, scrubbed test env, QA-owned tests, repeat detection, budgets (ARCHITECTURE §5) |
| **Software engineering fundamentals** | Typed contracts, 34 tests (unit + e2e), strict type-check, small modules with one job, idempotent side effects, atomic writes |
| **Workflow observability** | `events.jsonl`, per-attempt usage records, `report.html`, `metrics.json`, README charts |
| **Judgement about where autonomy stops** | README §6 table: cost of being wrong × reversibility decides who decides |

## Likely questions and good answers

**Why not let an LLM orchestrate the agents?**
Orchestration is where predictability matters most. The paths are known (analyse → design → build → verify → release) and the interesting decisions are what to do when something fails. Those are policy decisions I want to test, version and audit, so they live in code. The LLMs do the parts that need judgement and generation.

**How do you stop the developer agent from cheating, for example by weakening tests?**
Three ways. QA writes the acceptance tests before the code exists. Those tests live in `test/acceptance/`, a protected path the developer cannot modify. And gates are decided by actually running the tests, not by any agent's opinion. If an agent claims "pass" against failing evidence, the orchestrator logs `agent.claim_contradicted` and the evidence wins.

**What happens when the architect and developer disagree?**
The developer must not silently work around the design, so it raises a `design_deviation`. The architect owns the design and rules on it with a recorded rationale. That is one round. If the developer insists on the same point, it is no longer a technical question, it is an ownership question (here the ledger belongs to Finance), so the run escalates to a human with both positions. The human answers with `resume --guidance`, which is recorded and passed to the developer.

**Why three iterations?**
It is a budget, not a magic number. Most fixable failures are fixed in one feedback round. If three attempts with specific feedback have not converged, the problem is usually the requirement or design, not the code, and more attempts just cost money. Scenario 03 shows the escalation. All limits live in `src/config.ts`.

**How do you handle the model provider going down?**
The gateway classifies errors: 429, 5xx and connection errors are retryable, 4xx are not. It retries with exponential backoff. After 3 consecutive failures the circuit breaker opens and calls go to the secondary model, which is cheaper, so failover even lowers the cost. If everything is down, the run pauses with its state checkpointed, and `resume` continues from the last completed step. Idempotency keys make sure nothing is applied twice.

**How do you know the generated code is any good, beyond tests passing?**
A rubric scores verified acceptance criteria, suite health, security, scope adherence, coverage, size against a human-written baseline, and iterations. The baseline is run through exactly the same tools on a clean clone, so the comparison is fair. Plus a human reviews the evidence pack before merge.

**Is this real or staged?**
The model responses are scripted for the demo, so it is deterministic and runs offline. That is stated clearly. Everything else is real. The tests actually run with `node --test` and actually fail, git actually branches and merges, the scanner actually scans the files, and the policy actually blocks writes. The same code path runs against Claude with `--provider anthropic`.

**What would break first at scale?**
File-based state and single-process execution (fix: Postgres plus a queue). Lexical repo inspection on a large monorepo (fix: a code index). Process-level sandboxing (fix: container per run without network). And cost: the developer returns whole files, so diffs plus prompt caching are the first optimisation.

**Why payments / partial refunds?**
It has crisp invariants that tests can check (never refund more than captured), a real reliability concern (idempotency on retries), and a compliance concern (no card numbers in logs). That makes the gates meaningful, and it is the domain Pine Labs works in.

**What did you deliberately not build?**
Real PRs, a web UI, container sandboxing, multi-run concurrency and SSO. Each is listed in the README with the reason. The brief asked for a coherent vertical slice, and I'd rather show one path that is safe end to end.

**How did you use the reference project (ExploitOS)?**
It showed a clean pattern for typed hand-offs between sequential agents and for tracing every LLM call. It also stated its own gap: "no human approval required at any step". It never runs the code it writes. This project keeps the good patterns and adds the missing parts: test execution, failure handling, policy guardrails and human control.

## Numbers worth remembering

| | |
|---|---|
| Agents | 6 (8 agent tasks, each with its own schema) |
| Scenarios | 10, all green in `demo-all` |
| Tests | 34 (guardrails, gateway, every scenario end to end) |
| Minimum demo | 2 iterations, 10 model calls, ~$0.19 simulated, rubric 98/100 |
| Limits | 3 iterations, 1 deviation round, 2 retries, 2 repairs, breaker at 3, 40 calls, $2 per run |
| Acceptance tests | 6 criteria, 15 tests total after the change |

## Glossary

- **Acceptance criterion (AC)**: a Given/When/Then statement a test can verify.
- **ADR**: architecture decision record; a short recorded design decision with its reason.
- **Circuit breaker**: stops calling a failing dependency for a while instead of hammering it.
- **Idempotency**: doing the same operation twice has the same effect as doing it once.
- **PAN**: primary account number (the card number); must never appear in logs under PCI DSS.
- **SAST**: static application security testing; scanning source code for risky patterns.
