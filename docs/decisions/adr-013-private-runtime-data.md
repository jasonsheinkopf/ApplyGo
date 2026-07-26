# ADR-013: Keep candidate data outside Git

- Status: accepted
- Date: 2026-07-26
- Owners: ApplyGo project

## Context

ApplyGo must ingest résumés, detailed career notes, job descriptions, application history, generated assessments, and eventually browser artifacts. These records contain personal data and may include confidential employment information. They must not be committed to the repository or treated as source-code configuration.

GitHub Secrets are designed to inject small secret values into workflows. They are not a document store, relational database, audit trail, or user-data system.

## Decision

The first vertical slice uses three separate storage classes:

1. **Source control** contains code, schemas, synthetic tests, and documentation only.
2. **Private object storage** contains uploaded source documents. The local implementation uses `data/private/`; Docker uses a named volume. A hosted implementation may replace this with encrypted object storage.
3. **Database storage** contains users, profiles, evidence records, jobs, assessments, provenance, and model-run metadata. Local development defaults to SQLite; Docker and intended production deployments use PostgreSQL.

Runtime credentials are supplied through `.env` locally or a deployment secret manager. `.env`, database files, and private artifacts are ignored by Git.

## Consequences

- a repository clone contains no candidate data
- users can maintain separate profiles in one database
- uploaded documents survive independently of source commits
- backups and deletion must cover both database and object storage
- public deployment is prohibited until authentication, authorization, TLS, encryption, retention, and recovery are implemented
- CI uses synthetic fixtures only

## Validation and rollback

Validation requires confirming that uploaded files and database records do not appear in `git status`, tests do not require personal documents, and Docker volumes retain data across container recreation.

The storage adapter can later move from local files to S3-compatible storage without changing the evidence and document domain models.
