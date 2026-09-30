# @flowlinejs/core

Framework-agnostic core of [Flowline](../../README.md): the workflow document model, `defineNode`
/`defineTrigger`/`definePlugin`, the registry that turns plugins into a JSON manifest, refs and
templates, the tree helpers, and `validateWorkflow`. Pure and isomorphic — no Node built-ins, no
server-only code — so it runs in the browser as well as on a server.

## Install

```sh
pnpm add @flowlinejs/core zod@^4
```

`zod` 4 is a required peer dependency.

## Usage

```ts file=flowline.ts
import { defineNode, ui, workflow, ref, createRegistry, definePlugin, defineTrigger } from "@flowlinejs/core";
import { z } from "zod";

const loadContact = defineNode({
  type: "crm.loadContact",
  name: "Load contact",
  summary: "Load {{contactId}}",
  input: z.object({ contactId: ui(z.string(), { label: "Contact" }) }),
  output: z.object({ id: z.string(), name: z.string() }),
  run: ({ input }) => ({ id: input.contactId, name: "Ada" }),
});

const contactCreated = defineTrigger({
  type: "crm.contactCreated",
  name: "Contact created",
  kind: "event",
  event: "contact.created",
  config: z.object({}),
  payload: z.object({ contactId: z.string() }),
});

const crm = definePlugin({ id: "crm", name: "CRM", nodes: [loadContact], triggers: [contactCreated] });
export const registry = createRegistry([crm]);

export const doc = workflow("welcome-contact")
  .trigger(contactCreated, {})
  .step("contact", loadContact, { contactId: ref("trigger.contactId") })
  .build();
```

`@flowlinejs/engine` interprets the resulting `WorkflowDoc`; `@flowlinejs/react` renders it from the
manifest that `createRegistry` produces. See the [root README](../../README.md) for the full
quick start and `docs/` for the design spec and plugin guide.

## Agents

Everything an AI agent needs to read and edit a `WorkflowDoc` lives here, with no I/O.

- **Reads** take `(doc, manifest, args, opts?)` and return compact, budgeted results. `overview`
  and `outline` render the workflow as an outline within `budget` characters (default 4000);
  whatever doesn't fit is listed in `omitted`, each with the exact call that returns it.
  `focus` and `getSteps` return one or more steps with config, compact schema and refs in
  scope, cutting long strings unless `full: true`. `findSteps`, `availableRefs`,
  `listNodeTypes`, `describeNodeTypes` and `getIssues` complete the set; `reads` holds them all
  by name.
- **`apply(doc, commands, manifest)`** runs a batch of commands atomically: either every command
  succeeds and you get the new `doc`, or nothing changes and `error` names the failing
  command's path (`commands[2].at.after`) with a hint. There are single-step commands
  (`addStep`, `setConfig`, `setNote`, `setColor`, …), section commands (`addSection`, …) and
  bulk ones (`insertSteps` with nested branches, `updateSteps`, `moveSteps`, `wrapSteps`, …).
  `$1` names the step the first command created, and a fragment's `ref: "deal"` names it
  `$deal`, in later step arguments and in `steps.$deal…` refs and templates. `ids` maps each
  placeholder to its real ID, and `issues` reports the validation issues the batch added and
  cleared.
- **`commandCatalog(manifest)`** returns the tools a tool-calling model sees: `apply` and one
  tool per read, with descriptions and JSON Schema inputs built from your manifest.
  **`runTool({ doc, manifest }, name, args)`** runs one call. For `apply` it returns the result
  to send back to the model in `result`, and the new doc to keep in `doc`.

```ts file=agent.ts
import { apply, commandCatalog, overview, runTool } from "@flowlinejs/core";
import { doc, registry } from "./flowline";

const manifest = registry.manifest();

export const result = apply(
  doc,
  [
    {
      op: "addStep",
      at: { after: "contact" },
      id: "refresh",
      type: "crm.loadContact",
      config: { contactId: { $ref: "steps.contact.id" } },
    },
    { op: "setNote", id: "$1", note: "Reload in case the contact changed" },
    { op: "addSection", first: "contact", last: "$1", title: "Load the contact", color: "blue" },
  ],
  manifest,
);
if (!result.ok) throw new Error(`${result.error.path}: ${result.error.message}`);

// The whole workflow in at most 2000 characters, with follow-up calls for anything left out.
export const summary = overview(result.doc, manifest, { budget: 2000 });

// What a model gets as tools, and one call as the model would make it.
export const catalog = commandCatalog(manifest);
export const checked = runTool({ doc: result.doc, manifest }, "getIssues", {});
```

In the browser, `@flowlinejs/react`'s agent bridge runs the same tools against a live editor, so
each batch is one undo step (see the [react README](../react/README.md#agent-bridge)).
