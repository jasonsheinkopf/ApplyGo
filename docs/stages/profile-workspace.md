# Candidate Profile Workspace

This slice creates ApplyGo's first product-oriented frontend and makes candidate onboarding testable before job-search automation is expanded.

## User flow

1. Open the responsive ApplyGo dashboard on a phone, tablet, or computer.
2. Configure a default model provider through the local setup page.
3. Create a candidate workspace.
4. Upload original résumé, Markdown, or text documents and add detailed career notes.
5. Review extracted statements and explicitly approve the evidence that ApplyGo may use.
6. Record target roles, locations, compensation, work style, and non-negotiable requirements.
7. Generate or regenerate a grounded professional profile.
8. Generate multiple named résumé versions for different purposes and delete obsolete versions.

## Device behavior

The browser classifies the current surface as mobile, tablet, or desktop. CSS remains responsive even when user-agent detection is unavailable. Mobile uses bottom navigation and a single-column task flow. Tablet uses wider touch-friendly cards. Desktop uses denser two-column workspaces.

## Data and safety rules

- uploaded originals remain unchanged in private storage
- generated profiles and résumés use only approved evidence
- résumé outputs are separate versioned records
- deleting a generated résumé does not delete source documents or evidence
- local provider credentials are written to `data/private/provider.env` with owner-only permissions and are excluded from Git
- browser JavaScript never receives saved provider credentials
- the Cloudflare deployment wizard and Cloudflare secret management remain a follow-up

## Current boundary

The frontend is intentionally focused on candidate intelligence. It does not yet provide PDF/DOCX rendering, visual résumé-template optimization, model connection tests, automated Cloudflare resource creation, background Routine result collection, or job-specific résumé generation. Those are subsequent slices built on the same profile and résumé-version records.
