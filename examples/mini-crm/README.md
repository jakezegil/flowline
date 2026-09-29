# mini-crm

An example CRM that embeds Flowline. It defines its own `crm` plugin (nodes and triggers over its
data), ships demo workflows built in code, and serves both its own REST API and the Flowline engine
from one Hono app.

## Quick start

```sh
pnpm install
pnpm --filter @flowlinejs/example-mini-crm dev   # or: pnpm --filter ./examples/mini-crm dev
```

`dev` runs the server on `http://localhost:8787` (reloading on change) and the web app on
`http://localhost:5173`. Vite proxies `/api` and `/flowline` to the server. Open the web app.

A two-minute tour:

1. **Webhook tester**: send the prefilled enterprise lead. The response links to its run.
2. **Runs**: the run waits at "Manager approval". Approve it from the bar above the canvas, or
   from **Approvals**.
3. **Outbox**: the lead's new owner got "Enterprise lead approved".
4. **Deals**: set "Navy Labs expansion" to Won. The row shows the follow-up run it started, which
   emails the customer after a one-minute delay.
5. **Workflows**: open any workflow in the editor, or create one with **New workflow**.

**Reset demo data**, at the bottom of the sidebar, cancels unfinished runs and restores the seed
data.

## Web app

`web/` is a React app (Vite, React Router 7) that embeds `@flowlinejs/react` in CRM pages:

| Page | What it shows |
| --- | --- |
| Contacts | Contacts table. "New contact" reports `contact.created`. Each row's **AI call** and **VoIP call** log a finished sample call (`POST /api/calls`), and the toast links the runs it started |
| Deals | Pipeline summary and deals table. The stage select PATCHes the deal (`deal.updated`). Each row shows since when the deal has been in its stage, and links to the latest run about the deal, whether a change or the stuck-deal sweep started it |
| Workflows | Every workflow with its trigger and published version. "New workflow" picks a name and a trigger, saves the workflow as a draft, then opens the editor |
| Workflow editor | `<WorkflowEditor>`, full-bleed, with a breadcrumb in `headerLeft` |
| Runs | `<RunList>` beside `<RunViewer>`. `/runs/:id` deep links a run, and `?workflow=` filters the list. While a run waits on an approval, a bar above the viewer approves or rejects it |
| Approvals | Pending and decided approvals, with Approve and Reject |
| Outbox | Sent emails with a reading pane, each linking to the run that sent it |
| Webhook tester | POSTs a JSON body to a webhook workflow, optionally with `X-Request-Id`, and links to the run |

How it wires Flowline (`web/src/app.tsx`):

- One `<FlowlineProvider client={createClient({ baseUrl: "/flowline" })}>` wraps the app.
- `widgets={{ "crm.userSelect": UserSelect }}` renders the plugin's user ID fields (owner,
  approver) as a user picker (`web/src/widgets/user-select.tsx`). `/dev/widgets` shows it in
  every state.
- `icons` supplies the manifest's icons that Flowline doesn't bundle.
- `theme={{ colorMode }}` follows the CRM's light, dark or system setting. The CRM's own colors
  (`web/src/styles.css`) use the same values as Flowline's `--fl-*` tokens, so no token overrides
  are needed.

`MINI_CRM_API` points the proxy at another server (default `http://localhost:8787`), and
`WEB_PORT` changes the web port. `pnpm --filter @flowlinejs/example-mini-crm build` builds the app
into `web/dist`.

## Server

```sh
pnpm --filter @flowlinejs/example-mini-crm start   # server only; `dev:server` reloads on change
```

The server listens on `http://localhost:8787` and runs a background worker (`concurrency: 2`,
`pollMs: 250`). `PORT` changes the port, and `PUBLIC_URL` changes the origin used in callback
URLs.

On startup the demo workflows are saved and published for `acme`. A workflow that already exists
is left alone, so edits made in the editor survive a restart against Postgres.

The host registers the built-in plugin itself, with
`createBuiltinPlugin({ compare: "strict", operators: [isUnassigned] })`:

- **Strict by default.** Conditions and switches compare values of the same type only, with no
  parsing of numeric text and no case folding. The demo workflows compare with typed literals
  (`500`, not `"500"`), so they behave the same as under loose. A condition can still choose
  **Loose** in the editor.
- **`isUnassigned`** (`server/src/operators.ts`) is a host operator. Conditions offer it as "is
  unassigned", and it is true for a missing, `null` or `""` value.

### Fake clock

`MINI_CRM_FAKE_CLOCK=1` runs the CRM and the engine on a clock you can move forward, so "three days
later" takes one request. It is off by default, and `pnpm dev` uses the real clock. The e2e tests
turn it on.

The fake clock starts at the real time and keeps ticking with it. `POST /api/demo/advance { ms }`
adds `ms` to it and moves everything that reads the clock:

- the store's timestamps, such as `stageEnteredAt` and a call's `endedAt`;
- the engine's timers, such as a Delay step, which the worker wakes once they are due;
- poll triggers. The route sweeps them before it answers, and the worker also sweeps them every
  second while the fake clock is on.

`POST /api/demo/rewind` sets the clock back to real time. A reset leaves the clock alone,
because a poll trigger remembers how far it has swept: after a rewind it finds nothing new until
the clock passes that point again. So rewind when you are done with time travel. The e2e
triggers spec does, so the specs after it see real time.

```sh
MINI_CRM_FAKE_CLOCK=1 pnpm --filter @flowlinejs/example-mini-crm start
curl -X POST localhost:8787/api/demo/advance -H 'content-type: application/json' \
  -d '{"ms":259200000}'   # 3 days
```

Without the fake clock both routes answer 404. In code, pass `advanceClock` and `rewindClock` to
`createMiniCrm` together with the `clock` they move (`createFakeClock()` from
`server/src/fake-clock.ts`).

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
on `/api/*` and on `/flowline/*`. Anyone who can reach the server can read everything, decide
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

- `server/src/crm-store.ts`: the in-memory CRM (contacts, deals, users, calls, outbox, approvals)
  with seed data. It reports `contact.created`, `deal.updated`, `ai_call.ended` and
  `voip_call.ended` to a listener. The app forwards them to `engine.emit`, with the event ID as the
  dedupe key.
  - The two call events come from two systems and differ in shape. The AI agent sends
    `{ call: { id, contactId, seconds, endedAt, transcriptSummary } }`, and the phone system sends
    `{ callId, contactId, durationMs, endedAt }`.
  - A deal's `stageEnteredAt` is set at seed time and whenever its stage changes.
  - Here a failed emit is only logged.
  - A production host would write events to a transactional outbox and redeliver them with the
    stored ID.
- `server/src/plugin/`: the `crm` plugin.
  - Nodes: `findContactByEmail`, `getContact`, `createContact`, `updateContact`, `assignOwner`,
    `getDeal`, `updateDeal`, `getUser`, `sendEmail` and `requestApproval`.
  - Triggers: `contactCreated`, `dealUpdated`, `callEnded` (a multi-event trigger) and
    `dealStuckInStage` (a poll trigger).
  - User ID fields use the `crm.userSelect` widget, which the web app registers.
- `server/src/operators.ts`: the host's `isUnassigned` rule operator.
- `server/src/flows/`: the demo workflows (see below).
- `server/src/app.ts`: `createMiniCrm()` wires the store, the engine and the Hono app. Its
  `onTriggerEvent` logs deduplicated deliveries and keeps the last 100 trigger events for
  `GET /api/demo/trigger-events`.
- `server/src/fake-clock.ts`: the clock behind `MINI_CRM_FAKE_CLOCK`.
- `server/src/index.ts`: starts the server.

### REST API

All bodies are JSON (send `content-type: application/json`; the `/flowline` editor API requires it
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
| `POST /api/calls` `{ id?, contactId, kind: "ai" \| "voip", durationSec, summary? }` | 201 `Call`; reports `ai_call.ended` or `voip_call.ended`. With an `id` that was logged before: 200 with that call, and its event is reported again, like a phone system redelivering its webhook |
| `GET /api/deals` | `Deal[]`, each with `stageEnteredAt` |
| `PATCH /api/deals/:id` `{ name?, stage?, amount?, ownerId? }` | `{ deal, changes }`, where `changes` names the fields that changed. Reports `deal.updated` when something changed. A stage change also cancels the deal's waiting `deal-stuck-in-stage` runs |
| `GET /api/users` | `User[]`. `role` is `rep` or `manager`, and `team` is `smb` or `enterprise` |
| `GET /api/outbox` | `OutboxMessage[]`, newest first: every email a workflow sent, with the `runId` and `workflowId` that sent it |
| `GET /api/approvals` | `Approval[]`, newest first: `{ id, runId, stepPath, title, approverId, status, createdAt, decidedAt }`. `status` is `pending`, `approved`, `rejected` or `expired` |
| `POST /api/approvals/:id/decision` `{ decision: "approved" \| "rejected" }` | 202 `{ approval }`, and the waiting run resumes. 409 `{ error, approval }` when it was already decided. 410 `{ error: "gone", approval }` when the run no longer waits, e.g. it was cancelled; the approval becomes `expired` |
| `GET /api/demo` | `{ tenantId, userId, webhooks }`. `webhooks` maps workflow IDs to webhook paths, e.g. `webhooks["inbound-lead-routing"]` |
| `POST /api/demo/reset` | 204. Cancels the tenant's unfinished runs, then restores the CRM seed data and empties the calls, outbox and approvals. Workflows are kept |
| `GET /api/demo/trigger-events` | The last 100 trigger events, newest first: deliveries that started no run (`trigger.deduped`, `trigger.rejected`) and poll sweeps (`poll.completed`, `poll.failed`) |
| `POST /api/demo/advance` `{ ms }` | 204. Only with the [fake clock](#fake-clock), else 404. Moves the clock forward by `ms`, then sweeps the poll triggers |
| `POST /api/demo/rewind` | 204. Only with the [fake clock](#fake-clock), else 404. Sets the clock back to real time |
| `/flowline/*` | The Flowline engine: the editor API (`/flowline/manifest`, `/flowline/workflows`, `/flowline/runs`, ...), webhooks and callbacks |

To find the runs a CRM change started, list them with `GET /flowline/runs?workflowId=...`.

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
   `run.resumed` event. Over HTTP the same guard is `POST /flowline/runs/:id/resume?step=<stepPath>`.
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
- **`any-call-ended`**: `crm.callEnded`, a trigger over two events, `ai_call.ended` and
  `voip_call.ended`.
  - `normalize` maps both payloads onto one shape,
    `{ call: { id, contactId, source, durationSec, endedAt, summary? } }`. The run's origin still
    names the raw event ("Event voip_call.ended").
  - The trigger dedupes on the call ID for an hour. A redelivered call therefore starts no second
    run, and shows up as `trigger.deduped` in `GET /api/demo/trigger-events`.
  - The workflow sets `minSeconds: 30`, so shorter calls start nothing.
  - The flow loads the contact. A strict condition then checks that `ownerId` is not empty. If it
    is set, the flow loads the owner and emails them. Otherwise it stops with "No owner".
  - Try it with **AI call** and **VoIP call** on a Contacts row.
- **`deal-stuck-in-stage`**: `crm.dealStuckInStage`, a poll trigger, set to `{ stage: "proposal",
  days: 3 }`.
  - Every 10 seconds, the sweep starts one run for each deal that is still in the stage and whose
    `stageEnteredAt + 3 days` falls in the swept interval. The item key is
    `<dealId>:<stageEnteredAt>`, so a stint fires once, and re-entering the stage is a new stint.
  - A deal that moves on before its three days are up never fires.
  - The run loads the deal again and checks, with a strict condition, that it is still in the
    stage. It then nudges the owner ("Navy Labs expansion has been in proposal for 3 days"), waits
    1 minute, and checks again. If the deal is still stuck, the run escalates to manager `u_ava`.
    Each check that fails stops the run with "Deal moved on".
  - When a deal's stage changes, the host cancels that deal's waiting or queued runs, by `system`
    with reason "Stage changed" (`cancelStuckRunsOnStageChange`, on by default). The run viewer
    shows who cancelled the run and why. Without the hook, the re-check stops the run instead.
  - Try it with the fake clock: advance 3 days, look at Outbox and Runs, then change the deal's
    stage on Deals.
  - The seeded doc is the annotated demo. Two sections, "Check the deal is still stuck" (blue, from
    `deal` to `still_there`, with a note) and "Escalate" (pink, from `recheck` to `escalate`), frame
    the checks and the escalation. Sticky notes sit on `nudge` ("Owner, not assignee") and `wait`
    ("1m in the demo, 1d in production"), and the `escalate` card is pink. Annotations are visual
    only: the engine ignores them, and they survive save, publish and load.
  - Try the annotation tools in the editor:
    - Click a card, shift-click another in the same list, and press ⌘G (Ctrl+G) to group them.
    - The section's chip menu can rename, recolour, annotate or ungroup it.
    - A card's "…" menu has Add note and Color.
    - `e2e/annotations.spec.ts` walks through this flow. It saves drafts but never publishes.

Steps run at least once, so the side-effecting nodes pass `ctx.idempotencyKey` to the store:

- A re-run `sendEmail` finds its message already in the outbox.
- `createContact` returns the contact it already created.
- `assignOwner` picks the same owner.

Domain errors (unknown ID, invalid value) become `FatalError`, because they will not fix
themselves. A store that talks to a real database or mail provider would throw `RetryableError`
for transient failures (timeouts, 429, 503), so the engine retries the step.
