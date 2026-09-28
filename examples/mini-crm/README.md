# mini-crm

An example CRM that embeds Flowkit. It defines its own `crm` plugin (nodes and triggers over its
data), ships demo workflows built in code, and serves both its own REST API and the Flowkit engine
from one Hono app.

## Server

```sh
pnpm --filter @flowkit/example-mini-crm start:server   # or dev:server to reload on change
```

The server listens on `http://localhost:8787` (`PORT` changes the port, `PUBLIC_URL` the origin
used in callback URLs) and runs a background worker (`concurrency: 2`, `pollMs: 250`). Storage is
in memory; set `DATABASE_URL=postgres://...` to use Postgres (migrated on startup). There is no
login: every request acts as user `demo-user` of tenant `acme`.

On startup the demo workflows are saved and published for `acme`. A workflow that already exists
is left alone, so edits made in the editor survive a restart against Postgres.

### Layout

- `server/src/crm-store.ts`: the in-memory CRM (contacts, deals, users, outbox, approvals) with
  seed data. It reports `contact.created` and `deal.updated` to a listener, which the app forwards
  to `engine.emit` (the event ID is the dedupe key).
- `server/src/plugin/`: the `crm` plugin. Its nodes are `findContactByEmail`, `getContact`,
  `createContact`, `updateContact`, `assignOwner`, `updateDeal`, `sendEmail` and
  `requestApproval`. Its triggers are `contactCreated` and `dealUpdated`. User ID fields use the
  `crm.userSelect` widget, which the web app registers.
- `server/src/flows/`: the demo workflows (see below).
- `server/src/app.ts`: `createMiniCrm()` wires the store, the engine and the Hono app.
- `server/src/index.ts`: starts the server.

### REST API

All bodies are JSON. Errors are `{ error }` with status 400 (invalid input), 404 (unknown ID),
409 (conflict) or 410 (gone).

| Route | Result |
| --- | --- |
| `GET /api/contacts` | `Contact[]`, newest first |
| `POST /api/contacts` `{ firstName, lastName, email, company?, source?, ownerId? }` | 201 `Contact`; reports `contact.created`. 409 when the email is taken |
| `GET /api/deals` | `Deal[]` |
| `PATCH /api/deals/:id` `{ name?, stage?, amount?, ownerId? }` | `{ deal, changes }`, where `changes` names the fields that changed; reports `deal.updated` when something changed |
| `GET /api/users` | `User[]` (`role` is `rep` or `manager`, `team` is `smb` or `enterprise`) |
| `GET /api/outbox` | `OutboxMessage[]`, newest first: every email a workflow sent |
| `GET /api/approvals` | `Approval[]`, newest first: `{ id, runId, title, approverId, status, createdAt, decidedAt }`, where `status` is `pending`, `approved`, `rejected` or `expired` |
| `POST /api/approvals/:id/decision` `{ decision: "approved" \| "rejected" }` | 202 `{ approval }`, and the waiting run resumes. 409 when already decided, 410 when the run stopped waiting, e.g. it was cancelled (the approval becomes `expired`). An approval that times out becomes `expired` too |
| `GET /api/demo` | `{ tenantId, userId, webhooks }`. `webhooks` maps workflow IDs to webhook paths, e.g. `webhooks["inbound-lead-routing"]` |
| `POST /api/demo/reset` | 204. Restores the CRM seed data and empties the outbox and approvals. Workflows and runs are kept |
| `/flowkit/*` | The Flowkit engine: the editor API (`/flowkit/manifest`, `/flowkit/workflows`, `/flowkit/runs`, ...), webhooks and callbacks |

Approvals never include the resume URL or its token. The token stays inside the server, and the
decision endpoint resumes the run with it (`engine.resume`).

To simulate an inbound lead, POST to the webhook path from `GET /api/demo`:

```sh
curl -X POST "http://localhost:8787$(curl -s localhost:8787/api/demo | jq -r '.webhooks["inbound-lead-routing"]')" \
  -H 'content-type: application/json' -H 'X-Request-Id: lead-1' \
  -d '{"email":"hank@globex.test","firstName":"Hank","lastName":"Scorpio","company":"Globex","source":"referral","employees":1200}'
```

### Demo workflows

- **`get-contact`**, **`create-contact`**, **`get-or-create-contact`**: sub-flows (`core.subflow`
  trigger). `get-or-create-contact` calls `get-contact`, and when nothing was found calls
  `create-contact` inside an If branch. Steps inside a branch are not visible after the branch
  rejoins (spec §4.4), so the flow cannot use the `create` step's output below the condition.
  Instead it looks the contact up again (`reload`), which now always finds it. The flow outputs
  `{ contact, created }`.
- **`inbound-lead-routing`** (webhook, deduplicated on `X-Request-Id`): get-or-create the contact,
  then switch on `source` to assign an owner (web: SMB team; referral: enterprise team; event and
  anything else: round robin). The contact is loaded again to read the new owner, for the same
  rejoin reason. Companies with 500 or more employees need approval from manager `u_ava`: approved
  emails the owner "Enterprise lead approved", while rejected (or timed out after 3 days) stops
  the run. Smaller leads get a welcome email.
- **`deal-won-follow-up`** (`crm.dealUpdated`, only when the stage changes to `won`): deals under
  10,000 stop ("Small deal"). Otherwise the flow waits 1 minute, loads the contact, composes a
  thank-you subject and body in a `core.transform` step, and emails the customer.

Steps run at least once, so the side-effecting nodes pass `ctx.idempotencyKey` to the store. A
re-run `sendEmail` finds its message already in the outbox, `createContact` returns the contact it
already created, and `assignOwner` picks the same owner.
