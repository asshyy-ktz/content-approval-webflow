# content-approval-webflow

A Webflow App that adds a multi-stage editorial approval workflow to CMS collections: ordered stages with required approver roles, an append-only transition log, publish gating, comment threads with mentions, review requests with due dates and reminders, an in-Designer kanban App Panel with field diffs against the last approved snapshot, and a CSV audit export.

Stack: Node.js 20, TypeScript, Express, better-sqlite3 behind a `DbAdapter`, hand-rolled Webflow Data API v2 client (no SDK), vanilla TypeScript Designer Extension bundled with esbuild.

## Layout

```
server/
  routes/                     oauth, webhooks, panel (App Panel API)
  services/webflow-client.ts  typed fetch wrapper: token bucket, refresh-on-401, 429 backoff
  services/workflow.ts        per-collection stage definitions (validation, save, delete)
  services/approvals.ts       stage moves with role checks, auto-revert, publish gate, flag handling
  services/items.ts           sync/reconcile with Webflow, webhook handlers, board and item detail, field diff
  services/comments.ts        per-item / per-field threads, mentions, resolve/reopen
  services/reviews.ts         review requests, reminder list, reminder job
  services/members.ts         team members, roles, personal panel tokens
  services/mailer.ts          Mailer interface + logging stub (writes to mail_log and stdout)
  services/audit.ts           append-only audit writes, unified feed, CSV export
  services/token-store.ts     encrypted token storage interface (AES-256-GCM)
  services/scheduler.ts       interval job (reminders)
designer-extension/           App Panel (src/panel.ts, index.html, panel.css, esbuild.config.mjs, webflow.json)
shared/                       types.ts, webflow-types.ts
db/schema.sql                 SQLite-shaped schema
```

## Concepts

- **Workflow**: per collection, 2 to 12 ordered stages (for example Draft -> Legal -> Editor -> Approved). The last stage is the *approved / publishable* stage. Each stage lists the roles allowed to move items out of it (approve, reject, request changes); roles on the final stage may publish. The owner (the installing Webflow user, read through `authorized_user:read`) implicitly holds every role.
- **Item state**: every CMS item in a collection with a workflow is tracked at exactly one stage (new items start at the first stage). Every move is recorded in `transitions` (from, to, action, actor, authorizing role, note). The table has triggers that reject `UPDATE` and `DELETE`; the delete guard is lifted only after the installation row is purged on uninstall.
- **Actions**: *approve* moves one stage forward; *reject* returns to the first stage; *request changes* returns one stage back. Reject and request-changes require a note. Reaching the final stage stores the live `fieldData` as the approved snapshot.
- **Publish gate**: publishing (`POST /v2/collections/{id}/items/publish`) is only allowed when the item is at the final stage, the actor holds a final-stage role, and the live item still hashes to the approved snapshot. If it does not, the item is reverted to review and nothing is published.
- **Edited after approval**: a `collection_item_changed` webhook compares the live item with the approved snapshot. On a difference the item moves back to the workflow's revert (review) stage, is flagged, and the owner and approver are notified. Nothing is un-published: if the item is live, the last approved version stays live and the flag says so. The owner acknowledges the flag in the panel.
- **Comments**: threads on the whole item or a single field; replies; `@email`, `@local-part` or `@name` mentions resolve to team members and trigger a mail; threads are resolved or reopened.
- **Review requests**: assign a member with a due date and note. Performing an action on the item at that stage completes the actor's open requests. `services/mailer.ts` is a stub that logs (and stores in `mail_log`); implement `Mailer` and call `setMailer()` to send real email. A job every `REMINDER_INTERVAL_MIN` minutes mails assignees of overdue or soon-due requests (once per 24 h each); the Reviews tab lists them.
- **Team & auth**: the owner token (shown once after install, in the URL fragment; only its SHA-256 is stored) signs in as owner. The owner adds members with roles; each member gets a personal token (also stored hashed) so their actions are checked against their own roles.
- **Audit export**: `GET /api/audit/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&collectionId=...` merges transitions and audit events (comments, reviews, publishes, flags, team and workflow changes); cells starting with `=`, `+`, `-`, `@` are prefixed to defuse spreadsheet formulas.

## OAuth scopes

| Scope | Why |
| --- | --- |
| `cms:read` | List collections and items, read live content for diffs and the publish gate |
| `cms:write` | Publish items (`items/publish`) |
| `sites:read` | Resolve authorized sites, list collections, register webhooks |
| `authorized_user:read` | Identify the installing user as the app owner |

Install flow: `GET /oauth/authorize` (random `state`) -> Webflow -> `GET /oauth/callback` exchanges the code, stores tokens encrypted through the `TokenStore` interface, creates the owner member, registers the `collection_item_changed`, `collection_item_created`, `collection_item_deleted` and `app_uninstalled` webhooks, then redirects to the App Panel with the site id and owner token in the URL fragment. On `app_uninstalled` the app purges stored tokens, workflows, items, transitions, audit log, comments, reviews, members, settings, mail log and webhook registrations. Webhook signatures (`x-webflow-signature` + `x-webflow-timestamp`, HMAC-SHA256 with the client secret, 5 minute tolerance) are verified against the raw body.

## Data API endpoints used

| Purpose | Request |
| --- | --- |
| Authorized user | `GET /v2/token/authorized_by` |
| Site | `GET /v2/sites/{siteId}` |
| Collections | `GET /v2/sites/{siteId}/collections`, `GET /v2/collections/{collectionId}` |
| Items | `GET /v2/collections/{collectionId}/items?limit=100&offset=0`, `GET /v2/collections/{collectionId}/items/{itemId}` |
| Publish | `POST /v2/collections/{collectionId}/items/publish` |
| Webhooks | `POST` / `GET /v2/sites/{siteId}/webhooks`, `DELETE /v2/webhooks/{webhookId}` |

Example requests:

```http
GET /v2/collections/{collectionId}/items/{itemId}
Authorization: Bearer <token>

POST /v2/collections/{collectionId}/items/publish
{"itemIds":["<itemId>"]}

POST /v2/sites/{siteId}/webhooks
{"triggerType":"collection_item_changed","url":"https://<host>/webhooks/{siteId}/item-changed"}
```

## App Panel API (behind `X-Site-Id` + `X-Admin-Token`)

`GET /api/me`, `GET /api/collections`, `GET|PUT|DELETE /api/workflows[/:collectionId]` (writes owner-only), `POST /api/collections/:id/sync`, `GET /api/board/:collectionId`, `GET /api/items/:collectionId/:itemId`, `POST .../actions` (`advance` | `reject` | `request_changes`), `POST .../publish`, `POST .../flag/clear` (owner), `GET|POST .../comments`, `POST /api/comments/:id/resolve`, `POST .../reviews`, `GET /api/reviews`, `POST /api/reviews/:id/complete|cancel`, `GET /api/reminders`, `GET|POST|PUT|DELETE /api/members` (writes owner-only), `GET /api/audit`, `GET /api/audit/export.csv`, `GET|PUT /api/settings`, `GET /api/mail-log` (owner).

## Rate-limit strategy

Webflow allows 60 requests/minute per site. Each site has a token bucket (capacity 60, refill 1/s) that all calls pass through. A `429` blocks the whole bucket until `Retry-After` (or exponential backoff 1 s, 2 s, 4 s..., whichever is longer, plus jitter), up to 5 retries. A `401` triggers one refresh-token exchange and retry. `GET` requests also retry twice on 5xx. Webhook handlers acknowledge immediately and do their API calls afterwards; approved items are re-read live only when needed for the comparison.

## Local development

1. `cp .env.example .env` and fill `WEBFLOW_CLIENT_ID` / `WEBFLOW_CLIENT_SECRET` from your Webflow App settings.
2. Webflow requires https and a public URL: run your own tunnel (for example `ngrok http 3000`) and set `APP_PUBLIC_URL` and `WEBFLOW_REDIRECT_URI` (`<url>/oauth/callback`) to it, and register the same redirect URI in the Webflow App. This repo does not start a tunnel.
3. `npm install`, `npm run build:extension`, `npm run dev`.
4. Visit `<APP_PUBLIC_URL>/oauth/authorize` to install on a site, open the App Panel, define a workflow in the Workflows tab, then use "Sync from Webflow" on the Board.

Environment variables are documented in `.env.example`.
