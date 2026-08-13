# Architecture documentation

This directory holds two things that used to have no home: a structural (C4) model of ApplyGo,
and two narrative design docs written before the Cloudflare implementation existed
(`local-cloudflare-dual-mode.md`, `model-provider-routing.md` -- both still accurate background
reading, referenced from the [Decision Register](../decisions/index.md)).

## Why C4 / Structurizr

The existing documentation is strong on *behavior*: `docs/workflow/agent-workflow.md` shows, in
detail, how a job posting moves through screening, scoring, human review, and material generation.
What was missing was a *structural* answer to "what actually runs, and what talks to what" --
independent of any one workflow, and stable while workflows change. C4 is a minimal-notation way
to answer that at three zoom levels (system, container, component) without inventing a bespoke
diagram vocabulary each time. Structurizr keeps that model as text (DSL) next to the code it
describes, so it is reviewable in a pull request and can drift-check against the code the way any
other file in this repo can.

## What `structurizr/workspace.dsl` represents

[`structurizr/workspace.dsl`](structurizr/workspace.dsl) is a C4 model built directly from
`cloudflare/src/` and `extension/`, not from the roadmap or product docs. It deliberately shows
*shape*, not *behavior* -- one short sentence per element, short verbs on every relationship
("calls," "reads/writes," "polls," "submits through"). If you want to know how something happens,
that's what the Mermaid workflow doc is for; this model only answers what exists and what talks to
what. It has three views, current-implementation only:

- **System Context** -- the candidate, ApplyGo, and the two external systems it talks to: LLM
  Providers (Anthropic and OpenAI, used interchangeably) and ATS & Application Sites (the job
  board APIs ApplyGo polls and the employer application pages the extension fills).
- **Containers** -- the Worker/API (one Cloudflare Worker serving both the JSON API and the
  server-rendered dashboard -- there is no separate front-end deployable), D1, R2, and the browser
  extension.
- **WorkerComponents** -- eight major responsibilities inside the Worker: API & Dashboard,
  Profile & Evidence, Company Discovery & Scanning, Job Screening & Fit Assessment, Resume
  Generation, Cover Letter Generation, Application Field Matching, and the Developer Console & Eval
  Harness. Every LLM call a component makes is drawn as a single "Calls" edge straight to LLM
  Providers -- there's no separate internal gateway box, since at this zoom level the interesting
  fact is *that* a component calls a model, not which of the fourteen named tasks it invokes.

**Scoped to the Cloudflare implementation.** ApplyGo also has an alternate, currently supported
local-mode deployment (FastAPI + SQLite/Postgres, per ADR-014) that implements a small subset of
the pipeline (profile, manual job entry, single-tier fit assessment only). It's intentionally left
out of this model to keep the primary views to one deployment shape; see ADR-014 and
`docs/workflow/agent-workflow.md`'s scope note if you need it. Likewise, planned-but-unbuilt
capability (application status tracking, interviews, offers) isn't modeled here at all right now --
it lives in the roadmap docs until it's real, rather than as a dashed box in this model.

## What the Mermaid workflow documentation represents

[`docs/workflow/agent-workflow.md`](../workflow/agent-workflow.md) is the behavioral/process view:
how one job posting, one resume, one application actually moves through the system over time --
every LLM call, every deterministic check, every human decision point, and the database row state
at each step. It is left in place rather than moved here; nothing else in the repo links to it by
path, so moving it would only cost the file's git history for no structural benefit. This directory
links to it instead of duplicating it.

## How the two levels differ

| | Structurizr / C4 | Mermaid workflows |
|---|---|---|
| Question it answers | What exists, and what talks to what? | How does one thing move through what exists, over time? |
| Grain | System → container → component | Individual LLM calls, checks, state transitions |
| Changes when | A container or major responsibility is added/removed/moved | A pipeline's steps, prompts, or decision logic change |
| Current vs. planned | Current implementation only -- nothing planned is modeled yet | Solid vs. dashed arrows and nodes, documented in a legend at the top of the file |

If you're asking "does ApplyGo have a component that does X" or "what's the blast radius of
changing this container," read the C4 model. If you're asking "what exactly happens, in what
order, when a posting gets screened" or "how many LLM calls does resume generation make," read the
workflow doc.

## Running Structurizr Local

The DSL was written and validated against the current Structurizr CLI
(`structurizr validate`/`export`) and the on-premises Structurizr image. `structurizr/lite` is
deprecated by its own maintainers in favor of `structurizr/structurizr local`; use the latter.

From the repository root:

```bash
docker run -it --rm \
  -p 8080:8080 \
  -v "$(pwd)/docs/architecture/structurizr:/usr/local/structurizr" \
  structurizr/structurizr local
```

Then open <http://localhost:8080>. The mounted directory is exactly
`docs/architecture/structurizr/`, which is where `workspace.dsl` lives, so no path adjustment is
needed. If you drag elements around to improve the auto-layout, Structurizr Local will write a
`workspace.json` alongside `workspace.dsl` to persist that layout -- that file is generated, not
authored, so don't hand-edit it.
