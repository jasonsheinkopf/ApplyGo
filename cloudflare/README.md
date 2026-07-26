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

## Enroll a phone or computer

Create a short-lived one-time code from a trusted terminal:

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/admin/enrollments" \
  -H "content-type: application/json" \
  -H "x-applygo-setup-secret: YOUR_SETUP_SECRET" \
  -d '{"label":"Jason iPhone","minutes":15}'
```

Exchange that code from the device onboarding screen or directly:

```bash
curl -i -X POST "https://YOUR-WORKER.workers.dev/auth/enroll" \
  -H "content-type: application/json" \
  -d '{"code":"ONE_TIME_CODE","device_name":"Jason iPhone"}'
```

The response sets a Secure, HttpOnly, SameSite=Strict cookie. The browser remembers the device without exposing a privileged GitHub or Cloudflare token to frontend JavaScript.

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
- one-time device enrollment
- hashed session-token storage
- remembered secure browser sessions
- device listing and revocation
- authenticated private artifact transfer

The next Cloudflare slice will add the responsive PWA, profile/job APIs, export/import, local-worker registration, and deployment automation.
