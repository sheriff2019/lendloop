# What I would change to run LendLoop in production

The take-home runs everything locally: a Convex local backend, n8n in Docker on SQLite, and Mailpit. This is what
I'd change before real neighbours use it, roughly in order of importance.

## 1. Hosting and topology

- **Convex:** a production deployment (`npx convex deploy`) with its own environment variables, separate from dev.
- **Next.js:** on Vercel, or a container behind a CDN. Preview deployments per pull request, each pointing at a
  Convex preview deployment.
- **n8n:**
  - Self-hosted on a small VM or container service, behind TLS (Caddy/Traefik), on **PostgreSQL** instead of
    SQLite, with daily backups.
  - **Queue mode** (Redis + one or more workers), so a burst of loan events doesn't block the webhook.
  - The editor behind SSO/basic auth and an IP allow-list. Only `/webhook/*` is reachable from the internet.
- **Email:** a real provider (Postmark, SES, Resend) with SPF, DKIM and DMARC on the sending domain, a bounce
  webhook, and a "manage email preferences" link. Reminders are wanted by owners, but borrowers should be able to
  mute them.

## 2. Secrets and the signing scheme

- Secrets live in a secret manager (AWS Secrets Manager / Doppler / Vault) and reach Convex and n8n at deploy
  time. n8n reads them through its **external secrets** integration instead of `$env`, so
  `N8N_BLOCK_ENV_ACCESS_IN_NODE` can go back to `true`.
- **Key rotation without downtime:** add a key id to the header (`v1,kid=2026-11=<hex>`). The verifier accepts the
  current and previous key during a rotation window.
- Restrict who can read n8n execution data, since it contains names and emails, and keep the 7-day pruning.

## 3. Reliability

- Replace the n8n static-data dedupe with an idempotency check against Convex (`/n8n/events/:id/claim`), so dedupe
  survives n8n restarts and works across queue workers.
- **Alerting** on the outbox: page someone if any row is `dead`, or if the oldest pending row is older than
  15 minutes. Alert if the daily reminder run hasn't reported by 08:30.
- A dead-letter screen with bulk retry; today it is one Retry button per failure.
- Rate limits on request creation per user per hour, via the Convex rate-limiter component.

## 4. Observability

- **Sentry** on the Next.js client and server, and on Convex functions via a log stream. Releases are tagged
  with the commit.
- Convex log streams sent to **Datadog** (or similar), with a dashboard for request volume, approval latency,
  outbox depth, delivery attempts and n8n failure rate.
- A correlation id (the `eventId`) carried from Convex → n8n → write-back, so one loan's journey can be followed
  across all three systems.

## 5. Security and privacy

- An **audit log** for admin actions (removals with reason, Trusted Lender changes, role changes), readable by
  admins and kept for a fixed period.
- **Account deletion and data export:** on account close, anonymise the user row and loans, keeping counts but
  dropping names and emails, and remove them from Clerk.
- A clear **retention policy**: closed loans anonymised after N months, and automation events pruned along with them.
- Content moderation for listings (report button, an admin queue) and image uploads, if photos are added, with
  type and size checks and stripped EXIF.
- A Content Security Policy and security headers (Clerk's CSP helper plus Next.js headers). Dependency scanning
  in CI (`npm audit`, Dependabot).
- Clerk: require email verification, enable bot protection, and consider passkeys.

## 6. Product

- Organisations or "neighbourhoods" (Clerk Organizations), so each street or building has its own board and admins.
- In-app notifications next to email, and a borrower "extend loan" request.
- A calendar view of a tool's bookings. Photos on listings.

## 7. Testing and delivery

- The Playwright suite runs in CI against a preview deployment, with a seeded Clerk dev instance and a
  throwaway n8n container.
- Contract tests for the n8n ↔ Convex payloads: the exact field sets are already pinned in unit tests.
- Staged rollout of workflow changes: export from staging n8n, review the JSON diff in a PR, import to production
  via CI. Workflow JSON stays the source of truth in git.
