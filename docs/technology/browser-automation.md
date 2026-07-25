# Browser Automation

Browser automation is ApplyGo’s highest-risk integration layer because job sites vary, authentication persists across sessions, page structures change, and application sites may intentionally resist automation.

## Recommended execution pattern

Use a **deterministic-first, agentic-recovery** strategy:

1. inspect page and identify ATS/site family
2. use known selectors, schemas, and deterministic mappings where available
3. validate page state after every material action
4. invoke model-based interpretation only for unknown layouts, ambiguous labels, and recovery
5. pause before sensitive, irreversible, low-confidence, or policy-restricted actions
6. checkpoint every completed step

This reduces cost and hallucination risk while preserving adaptability.

## Technology comparison

| Option | Best role | Advantages | Risks / gaps |
|---|---|---|---|
| Playwright | baseline browser engine | mature, deterministic, screenshots/traces, multiple languages | local operations and anti-bot complexity remain ours |
| browser-use | higher-level agentic navigation | rapid LLM-driven browser experiments | reliability, cost, and abstraction behavior require benchmarks |
| Stagehand | mixed natural-language and coded browser actions | useful bridge between deterministic and AI actions | provider/runtime dependency and changing API surface |
| Steel.dev | managed or self-hostable browser sessions | remote sessions, Playwright connection, persistent infrastructure, proxy/CAPTCHA options | usage cost, provider dependency, terms/compliance, remote identity |
| Claude in Chrome | supervised personal copilot | can operate in the user’s desktop Chrome and use paid-plan interaction | not mobile, not a durable workflow engine, consumer-plan automation limits, security boundary |
| custom extension | local authenticated bridge and handoff | close integration with the user’s real browser and UI | substantial security, maintenance, browser-store, and permission burden |

## Steel.dev assessment

Steel deserves a formal prototype. Its current positioning includes cloud browser sessions controllable through Playwright, open-source/self-hosted options, persistent or managed browser infrastructure, and paid anti-bot/CAPTCHA-related capabilities. This directly addresses unattended execution problems that local Playwright alone does not solve.

Steel should remain optional because:

- local execution may be cheaper and safer for authenticated personal sessions
- job sites’ terms and CAPTCHA intent still apply regardless of technical capability
- a hosted browser introduces personal-data, credential, and vendor-dependency concerns
- costs and session limits may change
- some workflows may work better through explicit human handoff than automated challenge solving

### Prototype acceptance criteria

Compare local Playwright and Steel on:

- login and session persistence
- Workday-like, Greenhouse-like, and custom ATS flows
- MFA and user handoff
- CAPTCHA occurrence and permitted resolution path
- file upload/download reliability
- screenshots, live viewing, and debugging
- restart recovery
- latency and cost per application
- geographic/IP consistency
- secret isolation and data retention

## CAPTCHA strategy

ApplyGo must not define success as “bypass every CAPTCHA.” The strategy is:

1. detect and classify the challenge
2. checkpoint the workflow
3. notify the user with the exact application and live session context
4. allow secure takeover where possible
5. resume automatically after the human completes the challenge
6. optionally evaluate provider-supported solving only when legally and contractually appropriate and explicitly enabled
7. abandon safely when the site cannot be completed under policy

## Security considerations

Browser agents can encounter prompt injection embedded in pages, malicious uploads, deceptive controls, and cross-origin data. The browser tool must expose a constrained action surface. Models should never receive unrestricted secrets, arbitrary filesystem access, or permission to execute code because a webpage requests it.

## Initial recommendation

Adopt Playwright as the browser abstraction baseline. Build an execution adapter interface and prototype both a local persistent-profile adapter and a Steel adapter. Defer browser-use or Stagehand adoption until they outperform a small deterministic-plus-model recovery layer on representative ATS benchmarks.

## Initial sources

- Steel documentation and product site: `https://docs.steel.dev/` and `https://steel.dev/`
- Playwright documentation: `https://playwright.dev/`
- browser-use repository/documentation: `https://github.com/browser-use/browser-use`
- Stagehand documentation: `https://docs.stagehand.dev/`
- Claude in Chrome help: `https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome`
