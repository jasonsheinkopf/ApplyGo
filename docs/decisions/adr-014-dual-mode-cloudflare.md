# ADR-014: Support local and personal Cloudflare modes

- Status: accepted
- Date: 2026-07-26
- Owners: ApplyGo project

## Context

ApplyGo is not intended to become a centrally operated subscription service. Many users will prefer a free local installation, while some users need portable state and phone access. The prototype demonstrated a convenient phone dashboard that remembered a repository token in browser storage, but storing a broad GitHub token in JavaScript-accessible storage is not an acceptable long-term credential model.

## Decision

ApplyGo will support two first-class modes:

1. **Local mode:** SQLite, local private files, and local execution.
2. **Cloudflare personal-cloud mode:** a user-owned Worker, D1 database, R2 bucket, and secure device sessions, with local execution by default and optional hosted execution later.

Cloudflare is a deployment adapter rather than a domain dependency. Data contracts, exports, evidence provenance, and workflow semantics must remain portable.

The remembered-device experience will use one-time enrollment codes exchanged for scoped device sessions. Browser sessions will be stored in secure HttpOnly cookies. Powerful GitHub, Cloudflare, or model-provider credentials will not be stored in browser localStorage.

## Options considered

### Local only

Rejected as the sole mode because it does not provide portable phone access or durable cloud state when the computer is unavailable.

### Railway as the universal default

Deferred as an optional hosted-worker path. It offers simple always-on deployment but introduces a recurring-cost expectation for users who only need local execution or portable state.

### Supabase plus an application host

Not selected as the primary template because it requires multiple services and more setup than the intended personal-cloud experience.

### Google Drive as the database

Rejected. Drive is appropriate for documents and backups but not as an improvised transactional application database.

### Browser-stored GitHub personal access token

Rejected for the production identity model. The prototype approach was convenient and useful for validation, but a write-capable repository token in localStorage creates excessive impact if frontend JavaScript is compromised.

## Consequences

- local mode remains free and simple
- Cloudflare users own their deployment and data
- phone access does not require a centrally hosted ApplyGo account
- the project must maintain SQLite/filesystem and D1/R2 adapters
- export/import compatibility becomes a required feature
- heavy Python and browser workflows may require a connected local worker
- Cloudflare-native code must remain limited to control-plane responsibilities until equivalent behavior is validated

## Validation

The decision is validated when:

- local mode continues to pass existing tests
- Cloudflare migrations can initialize a new D1 database
- the Cloudflare Worker can issue, exchange, authenticate, list, and revoke device sessions
- uploaded artifacts remain private in R2
- no privileged platform token is exposed to browser JavaScript
- a documented export can move representative records and files between modes
