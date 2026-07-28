# ApplyGo Personal Cloudflare Mode

This directory contains the portable data and device-session control plane for a user-owned ApplyGo deployment.

It does not create a shared ApplyGo service. Every installer creates resources in their own Cloudflare account.

## Resources

- one Worker
- one D1 database named `applygo`
- one private R2 bucket named `applygo-private`
- one Worker secret named `SETUP_SECRET`

## Setup

Install Node.js 20 or newer and authenticate Wrangler:

```bash
cd cloudflare
npm install
npx wrangler login
```

Create the data resources:

```bash
npx wrangler d1 create applygo
npx wrangler r2 bucket create applygo-private
```

Copy the returned D1 database ID into `wrangler.jsonc`. Create a long random setup secret:

```bash
npx wrangler secret put SETUP_SECRET
```

Apply the schema and deploy:

```bash
npm run migrate:remote
npm run deploy
```

## Production deployment (`applygo-prod`)

Production uses a dedicated Wrangler environment so local/personal experimentation never touches production names or data:

| Resource | Local/personal (default env) | Production (`--env production`) |
|---|---|---|
| Worker | `applygo-personal` | `applygo-prod` |
| D1 database (binding `DB`) | `applygo` | `applygo-prod-db` |
| R2 bucket (binding `FILES`) | `applygo-private` | `applygo-prod-private` |

Production-only scripts:

```bash
npm run check:prod          # dry-run bundle/build against the production env
npm run migrate:remote:prod # apply pending D1 migrations to applygo-prod-db
npm run deploy:prod         # wrangler deploy --env production
npm run release:prod        # migrate:remote:prod then deploy:prod, in order
```

Always run `release:prod` (or an equivalent migrate-then-deploy sequence) rather than `deploy:prod` alone, so schema changes land before the new Worker code that depends on them.

### One-time production resource creation

Run once, from an account holder's authenticated Wrangler session (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` in the environment):

```bash
npx wrangler d1 create applygo-prod-db
npx wrangler r2 bucket create applygo-prod-private
```

Copy the returned D1 `database_id` into the `env.production.d1_databases[0].database_id` field in `wrangler.jsonc` (a database ID is configuration, not a secret). Then store the production setup secret:

```bash
npx wrangler secret put SETUP_SECRET --env production
```

### Automatic GitHub deployment

Production is connected to GitHub through **Cloudflare Workers Builds** (Cloudflare dashboard → Workers & Pages → `applygo-prod` → Settings → Builds), not a GitHub Actions-held API token:

- Repository: `jasonsheinkopf/ApplyGo`
- Production branch: `main`
- Root directory: `cloudflare`
- Build command: `npm install && npm run typecheck && npm run check:prod`
- Deploy command: `npm run release:prod`
- Build watch paths: `cloudflare/**`

A push to `main` that touches `cloudflare/**` automatically applies pending migrations and redeploys `applygo-prod`. Pushes that only touch unrelated docs, the Python app, or other paths outside `cloudflare/**` do not trigger a build. Pull requests run Cloudflare's build/typecheck validation and produce a preview build rather than overwriting production.

The separate `.github/workflows/cloudflare.yml` GitHub Actions workflow provides fast PR feedback (typecheck + dry-run bundle) independent of, and in addition to, Cloudflare Workers Builds.

### Rollback

If a production deploy misbehaves:

```bash
npx wrangler deployments list --env production   # find the previous good deployment
npx wrangler rollback --env production           # roll the Worker back to the previous deployment
```

`wrangler rollback` reverts the deployed Worker code only; it does not undo D1 migrations. Because migrations in `cloudflare/migrations/` are additive and idempotent (`CREATE TABLE IF NOT EXISTS`), rolling back Worker code is safe even if a newer migration has already been applied. If a bad commit reaches `main`, revert or fix it on `main`; Workers Builds will redeploy automatically once `main` is healthy again.

## Enroll a phone or computer

The easiest path is the built-in browser onboarding page. From a trusted terminal, create a short-lived one-time code:

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/admin/enrollments" \
  -H "content-type: application/json" \
  -H "x-applygo-setup-secret: YOUR_SETUP_SECRET" \
  -d '{"label":"Jason iPhone","minutes":15}'
```

Then open `https://YOUR-WORKER.workers.dev/enroll` on the device to be enrolled (e.g. in Safari on an iPhone), enter the one-time code and a device name, and submit. The page posts directly to `/auth/enroll`, verifies the resulting session by calling `/me`, and shows a clear success or failure message. It never stores the code or session in `localStorage`; the session lives only in the Secure, HttpOnly, SameSite=Strict cookie set by the server response.

You can also exchange the code directly, without the browser page:

```bash
curl -i -X POST "https://YOUR-WORKER.workers.dev/auth/enroll" \
  -H "content-type: application/json" \
  -d '{"code":"ONE_TIME_CODE","device_name":"Jason iPhone"}'
```

Either way, the response sets a Secure, HttpOnly, SameSite=Strict cookie. The browser remembers the device without exposing a privileged GitHub or Cloudflare token to frontend JavaScript. Enrollment codes are single-use and expire after the requested number of minutes (max 60).

## Device management

Authenticated endpoints:

- `GET /me`
- `GET /devices`
- `POST /devices/:id/revoke`
- `POST /auth/logout`

A lost phone can be revoked from another remembered device. Revoking the current device also clears its cookie.

## Private files

Authenticated file endpoints:

- `POST /artifacts` using multipart field `file`
- `GET /artifacts/:key`

Uploads are limited to 15 MB and PDF, plain text, or Markdown in this initial slice. R2 objects are not made public.

## Current boundary

This is a control-plane foundation, not the completed Cloudflare product UI. It establishes:

- reproducible D1 schema
- private R2 binding
- a minimal browser device-enrollment page (`/enroll`)
- one-time device enrollment
- hashed session-token storage
- remembered secure browser sessions
- device listing and revocation
- authenticated private artifact transfer
- named production environment and automatic GitHub deployment via Cloudflare Workers Builds

The next Cloudflare slice will add the responsive PWA, profile/job APIs, export/import, and local-worker registration. The full Python/Jinja candidate-profile experience (resume parsing, evidence extraction, fit assessment, job-application workflows) still runs only in the local Python application (`src/applygo/`); it has not been ported to the Worker.
