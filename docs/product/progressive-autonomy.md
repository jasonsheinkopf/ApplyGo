# Progressive Autonomy

ApplyGo should not choose permanently between “human in the loop” and “fully autonomous.” It should move responsibility gradually, by capability, as evidence accumulates.

## Autonomy levels

| Level | System behavior | Human responsibility |
|---|---|---|
| 0 — Observe | record and analyze manual workflow | perform all actions |
| 1 — Assist | recommend jobs, draft materials, propose field values | review and execute |
| 2 — Prepare | assemble complete application package and prefill browser | correct and submit |
| 3 — Execute with approval | navigate and complete predictable flows, then pause | approve consequential actions and exceptions |
| 4 — Policy-bounded autonomy | submit applications that meet explicit policies and confidence thresholds | review audit trail and exception queue |
| 5 — Trusted routine autonomy | operate independently for proven site/workflow classes | manage policies and non-routine decisions |

Autonomy is assigned per action and workflow class, not as one global switch. A user might allow automatic rejection of clearly irrelevant jobs while still requiring approval for every submission.

## Promotion criteria

A capability moves to a higher level only when it meets defined thresholds for:

- factual correctness
- field-mapping accuracy
- unsupported-claim rate
- workflow completion rate
- exception detection
- restart and recovery success
- policy compliance
- cost and latency
- user override frequency

## Demotion and circuit breakers

The system automatically falls back to a safer level when:

- a site changes materially
- confidence drops below threshold
- authentication or account risk appears
- a sensitive question is encountered
- selected documents or target job are ambiguous
- repeated actions fail
- cost exceeds policy
- the user overrides recent outputs at an elevated rate

## Control surface

The phone experience should focus on:

- reviewing ranked jobs
- approving or rejecting materials
- responding to exact exception questions
- opening a live browser session for handoff
- seeing what the agent is doing now
- stopping or resuming a workflow
- inspecting costs, evidence, and action history

The phone controls execution; it does not need to host the automation runtime.
