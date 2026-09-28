# mini-crm

An example CRM that embeds Flowkit. It defines its own `crm` plugin (nodes and triggers over its
data), ships demo workflows built in code, and serves both its own REST API and the Flowkit engine
from one Hono app.

## Quick start

```sh
pnpm install
pnpm --filter @flowkit/example-mini-crm dev
```

`dev` runs the server on `http://localhost:8787` (reloading on change) and the web app on
`http://localhost:5173`. Vite proxies `/api` and `/flowkit` to the server. Open the web app.

A two-minute tour:

1. **Webhook tester**: send the prefilled enterprise lead. The response links to its run.
2. **Runs**: the run waits at "Request approval". Approve it from the bar above the canvas, or
   from **Approvals**.
3. **Outbox**: the lead's new owner got "Enterprise lead approved".
4. **Deals**: set "Navy Labs expansion" to Won. The row shows the follow-up run it started, which
   emails the customer after a one-minute delay.
5. **Workflows**: open any workflow in the editor, or create one with **New workflow**.

**Reset demo data**, at the bottom of the sidebar, cancels unfinished runs and restores the seed
data.

## Web app

`web/` is a React app (Vite, React Router 7) that embeds `@flowkit/react` in CRM pages:

| Page | What it shows |
| --- | --- |
| Contacts | Contacts table. "New contact" reports `contact.created` |
| Deals | Pipeline summary and deals table. The stage select PATCHes the deal (`deal.updated`), and each row links to the latest run a change started |
| Workflows | Every workflow with its trigger and published version. "New workflow" picks a name and a trigger, then opens the editor |
| Workflow editor | `<WorkflowEditor>`, full-bleed, with a breadcrumb in `headerLeft` |
| Runs | `<RunList>` beside `<RunViewer>`. `/runs/:id` deep links a run, and `?workflow=` filters the list |
| Approvals | Pending and decided approvals, with Approve and Reject |
| Outbox | Sent emails with a reading pane |
| Webhook tester | POSTs a JSON body to a webhook workflow, optionally with `X-Request-Id`, and links to the run |

How it wires Flowkit (`web/src/app.tsx`):

- One `<FlowkitProvider client={createClient({ baseUrl: "/flowkit" })}>` wraps the app.
- `widgets={{ "crm.userSelect": UserSelect }}` renders the plugin's user ID fields (owner,
  approver) as a user picker (`web/src/widgets/user-select.tsx`). `/dev/widgets` shows it in
  every state.
- `icons` supplies the manifest's icons that Flowkit doesn't bundle.
- `theme={{ colorMode }}` follows the CRM's light, dark or system setting. The CRM's own colors
  (`web/src/styles.css`) use the same values as Flowkit's `--fk-*` tokens, so no token overrides
  are needed.

`MINI_CRM_API` points the proxy at another server (default `http://localhost:8787`), and
`WEB_PORT` changes the web port. `pnpm --filter @flowkit/example-mini-crm build` builds the app
into `web/dist`.

## Server

```sh
pnpm --filter @flowkit/example-mini-crm start   # server only; `dev:server` reloads on change
```

The server listens on `http://localhost:8787` and runs a background worker (`concurrency: 2`,
`pollMs: 250`). `PORT` changes the port, and `PUBLIC_URL` changes the origin used in callback
URLs.

On startup the demo workflows are saved and published for `acme`. A workflow that already exists
is left alone, so edits made in the editor survive a restart against Postgres.

### Storage and restarts

Engine storage is in memory by default. Set `DATABASE_URL=postgres://...` to use Postgres, which
is migrated on startup.

The CRM itself (contacts, deals, outbox, approvals) is always in memory. So after a restart
against Postgres:

- Workflows and runs survive, but the CRM starts again from its seed data.
- Approvals of runs that are still waiting are rebuilt from the waiting runs
  (`restoreApprovals`), so they stay decidable.
- Contacts created before the restart are gone. Webhook dedupe is permanent, so replaying an old
  `X-Request-Id` still starts nothing.

### No authentication

**The demo has no authentication.** Every request acts as user `demo-user` of tenant `acme`, both
on `/api/*` and on `/flowkit/*`. Anyone who can reach the server can read everything, decide
approvals and edit workflows. Webhook slugs are visible too.

A production host must authenticate every request with its own session and derive the tenant and
user from it. Pass the same function to the engine as `authorize`. Returning `null` makes the
engine answer 401:

```ts
const engine = createEngine({
  // ...
  authorize: async (req) => {
    const session = await sessions.fromRequest(req); // your cookie or bearer-token auth
    if (!session) return null;
    return { tenantId: session.accountId, userId: session.userId };
  },
});
```

Run the same check as middleware in front of your own API routes, and scope every query to the
session's tenant. Check permissions per action: for example, only `approval.approverId` (or a
manager) may decide an approval, and the decision passes the session's user ID to
`engine.resumeRun` so the run's audit trail names who decided.

Treat webhook slugs as credentials, and show them only to users of the owning tenant.

### Layout

- `server/src/crm-store.ts`: the in-memory CRM (contacts, deals, users, outbox, approvals) with
  seed data. It reports `contact.created` and `deal.updated` to a listener, which the app forwards
  to `engine.emit`, with the event ID as the dedupe key.
  - Here a failed emit is only logged.
  - A production host would write events to a transactional outbox and redeliver them with the
    stored ID.
- `server/src/plugin/`: the `crm` plugin.
  - Nodes: `findContactByEmail`, `getContact`, `createContact`, `updateContact`, `assignOwner`,
    `updateDeal`, `sendEmail` and `requestApproval`.
  - Triggers: `contactCreated` and `dealUpdated`.
  - User ID fields use the `crm.userSelect` widget, which the web app registers.
- `server/src/flows/`: the demo workflows (see below).
- `server/src/app.ts`: `createMiniCrm()` wires the store, the engine and the Hono app.
- `server/src/index.ts`: starts the server.

### REST API

All bodies are JSON (send `content-type: application/json`; the `/flowkit` editor API requires it
on every POST, PUT and PATCH, even a bodyless one). Errors are `{ error }` with one of these
statuses:

- 400: invalid input, including an unknown owner ID.
- 404: unknown ID in the path.
- 409: conflict.
- 410: gone.
- 500: unexpected failure. You can retry.

| Route | Result |
| --- | --- |
| `GET /api/contacts` | `Contact[]`, newest first |
| `POST /api/contacts` `{ firstName, lastName, email, company?, source?, ownerId? }` | 201 `Contact`; reports `contact.created`. 409 when the email is taken |
| `GET /api/deals` | `Deal[]` |
| `PATCH /api/deals/:id` `{ name?, stage?, amount?, ownerId? }` | `{ deal, changes }`, where `changes` names the fields that changed. Reports `deal.updated` when something changed |
| `GET /api/users` | `User[]`. `role` is `rep` or `manager`, and `team` is `smb` or `enterprise` |
| `GET /api/outbox` | `OutboxMessage[]`, newest first: every email a workflow sent |
| `GET /api/approvals` | `Approval[]`, newest first: `{ id, runId, stepPath, title, approverId, status, createdAt, decidedAt }`. `status` is `pending`, `approved`, `rejected` or `expired` |
| `POST /api/approvals/:id/decision` `{ decision: "approved" \| "rejected" }` | 202 `{ approval }`, and the waiting run resumes. 409 `{ error, approval }` when it was already decided. 410 `{ error: "gone", approval }` when the run no longer waits, e.g. it was cancelled; the approval becomes `expired` |
| `GET /api/demo` | `{ tenantId, userId, webhooks }`. `webhooks` maps workflow IDs to webhook paths, e.g. `webhooks["inbound-lead-routing"]` |
| `POST /api/demo/reset` | 204. Cancels the tenant's unfinished runs, then restores the CRM seed data and empties the outbox and approvals. Workflows are kept |
| `/flowkit/*` | The Flowkit engine: the editor API (`/flowkit/manifest`, `/flowkit/workflows`, `/flowkit/runs`, ...), webhooks and callbacks |

To find the runs a CRM change started, list them with `GET /flowkit/runs?workflowId=...`.

**How approvals resume.** An approval stores only the waiting step, as `runId` and `stepPath`. It
never stores a callback token or resume URL.

1. The step waits on a callback, which gives it its timeout (3 days, then the Rejected branch).
2. The step creates the approval record in `suspend`'s `afterCommit`, so the approval appears only
   once the run can be resumed.
3. The decision endpoint claims the approval synchronously, so a concurrent second decision gets
   409.
4. It resumes the run with the authorized
   `engine.resumeRun(tenantId, runId, { decision }, userId, { expectStep: stepPath })`. With
   `expectStep`, the engine resumes only the callback wait of that step, checking and resuming in
   one compare-and-set, and answers `"gone"` otherwise. The call records `by` on the
   `run.resumed` event. Over HTTP the same guard is `POST /flowkit/runs/:id/resume?step=<stepPath>`.
5. If the resume throws while the run still waits at the step, the approval goes back to
   `pending` and the request fails with 500, so the client can retry. If the run stopped waiting
   meanwhile, the approval becomes `expired`.
6. `GET /api/approvals` expires pending approvals whose run has finished, e.g. one cancelled from
   the run viewer.

**Test step changes real data.** The editor's "Test step" runs a node's real handler. Testing
`crm.sendEmail` writes to the outbox, and testing `crm.createContact` creates a contact.

To simulate an inbound lead, POST to the webhook path from `GET /api/demo`. Webhook dedupe on
`X-Request-Id` is permanent, so use a fresh ID for each new lead:

```sh
curl -X POST "http://localhost:8787$(curl -s localhost:8787/api/demo | jq -r '.webhooks["inbound-lead-routing"]')" \
  -H 'content-type: application/json' -H "X-Request-Id: $(uuidgen)" \
  -d '{"email":"hank@globex.test","firstName":"Hank","lastName":"Scorpio","company":"Globex","source":"referral","employees":1200}'
```

Then approve the lead:

```sh
ID=$(curl -s localhost:8787/api/approvals | jq -r '.[0].id')
curl -X POST "localhost:8787/api/approvals/$ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"approved"}'
```

### Demo workflows

- **`get-contact`**, **`create-contact`**, **`get-or-create-contact`**: sub-flows with a
  `core.subflow` trigger.
  - `get-or-create-contact` calls `get-contact`. When nothing is found, it calls `create-contact`
    inside an If branch.
  - Steps inside a branch are not visible after the branch rejoins (spec §4.4). So the flow cannot
    use the `create` step's output below the condition. Instead it looks the contact up again
    (`reload`), which now always finds it. The flow outputs `{ contact, created }`.
  - Two concurrent runs for the same new email can both miss the lookup. The losing run's
    `crm.createContact` then returns the contact the other run created, instead of failing.
- **`inbound-lead-routing`**: a webhook, deduplicated on `X-Request-Id`.
  1. Get or create the contact.
  2. Switch on `source` to assign an owner: web goes to the SMB team, referral to the enterprise
     team, and event or anything else to round robin.
  3. Load the contact again to read the new owner, for the same rejoin reason.
  4. Companies with 500 or more employees need approval from manager `u_ava`. Approved emails the
     owner "Enterprise lead approved". Rejected, or timed out after 3 days, stops the run.
  5. Smaller leads get a welcome email.
- **`deal-won-follow-up`**: `crm.dealUpdated`, only when the stage changes to `won`.
  - Deals under 10,000 stop with "Small deal".
  - Otherwise the flow waits 1 minute and loads the contact. A `core.transform` step then
    composes a thank-you subject and body, and the flow emails the customer.

Steps run at least once, so the side-effecting nodes pass `ctx.idempotencyKey` to the store:

- A re-run `sendEmail` finds its message already in the outbox.
- `createContact` returns the contact it already created.
- `assignOwner` picks the same owner.

Domain errors (unknown ID, invalid value) become `FatalError`, because they will not fix
themselves. A store that talks to a real database or mail provider would throw `RetryableError`
for transient failures (timeouts, 429, 503), so the engine retries the step.
