# @flowkit/core

Framework-agnostic core of [Flowkit](../../README.md): the workflow document model, `defineNode`
/`defineTrigger`/`definePlugin`, the registry that turns plugins into a JSON manifest, refs and
templates, the tree helpers, and `validateWorkflow`. Pure and isomorphic — no Node built-ins, no
server-only code — so it runs in the browser as well as on a server.

## Install

```sh
pnpm add @flowkit/core zod@^4
```

`zod` 4 is a required peer dependency.

## Usage

```ts
import { defineNode, ui, workflow, ref, createRegistry, definePlugin, defineTrigger } from "@flowkit/core";
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

`@flowkit/engine` interprets the resulting `WorkflowDoc`; `@flowkit/react` renders it from the
manifest that `createRegistry` produces. See the [root README](../../README.md) for the full
quick start and `docs/` for the design spec and plugin guide.
