# Decision Register

Architecture decisions begin as candidates and become accepted only after evidence or an explicit tradeoff review.

| ID | Decision | Status | Evidence needed |
|---|---|---|---|
| ADR-001 | Build ApplyGo as personal, cloneable AI infrastructure rather than a SaaS-first product | proposed | user goals and deployment requirements |
| ADR-002 | Start with a modular monolith | proposed | domain and operational complexity review |
| ADR-003 | Use PostgreSQL as the production system of record | proposed | local setup and migration spike |
| ADR-004 | Use Playwright as the baseline browser engine | proposed | ATS benchmark |
| ADR-005 | Keep Steel.dev as an optional remote-browser adapter | proposed | cost, reliability, CAPTCHA/handoff spike |
| ADR-006 | Support hosted and local model providers behind adapters | proposed | task-level benchmark |
| ADR-007 | Use progressive autonomy with action-level policy gates | proposed | evaluation thresholds and UX prototype |
| ADR-008 | Use MLflow as the leading evaluation/experiment platform | proposed | tracing and evaluation proof of concept |
| ADR-009 | Preserve OpenTelemetry-compatible trace context | proposed | implementation spike |
| ADR-010 | Defer LangGraph/Temporal selection until durable workflow prototypes | proposed | orchestration comparison spike |
| ADR-011 | Treat the phone as a control surface, not the primary execution runtime | proposed | mobile/background constraints and UX validation |
| ADR-012 | Default CAPTCHA handling to secure human handoff | proposed | site/terms review and remote-session prototype |

## ADR template

```markdown
# ADR-NNN: Title

- Status: proposed | accepted | rejected | superseded
- Date:
- Owners:

## Context

## Decision

## Options considered

## Consequences

## Validation and rollback
```
